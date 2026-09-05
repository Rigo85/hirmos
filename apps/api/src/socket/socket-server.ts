import type { Server as HttpServer } from 'node:http';
import type {
  ClientToServerEvents,
  PlaybackCommandAck,
  PlaybackCommandResult,
  ServerToClientEvents,
} from '@hirmos/contracts';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AuthService } from '../auth/auth-service.js';
import { sessionCookieName } from '../routes/auth-routes.js';
import type { PlaybackService } from '../playback/playback-service.js';
import type { SessionRevocationNotifier } from '../auth/session-revocation.js';

interface SocketData {
  userId: string;
  deviceId: string;
  sessionId: string;
  sessionToken: string;
}

const deviceSchema = z.object({
  deviceId: z.uuid(),
  deviceName: z.string().trim().min(1).max(100),
  deviceType: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).default('unknown'),
});
const commandBase = z.object({ commandId: z.uuid(), expectedRevision: z.number().int().nonnegative() });
const claimSchema = commandBase;
const selectSchema = commandBase.extend({ trackRef: z.string().min(1).max(2048) });
const selectContextSchema = commandBase.extend({
  trackRefs: z.array(z.string().min(1).max(2048)).min(1).max(500),
  selectedIndex: z.number().int().nonnegative(),
  contextType: z.enum(['album', 'artist', 'search', 'home', 'genre', 'favorites']),
  contextRef: z.string().max(2048).nullable(),
}).refine((value) => value.selectedIndex < value.trackRefs.length, {
  message: 'selectedIndex must reference a track',
});
const updateSchema = commandBase.extend({
  leaseEpoch: z.number().int().nonnegative(),
  status: z.enum(['playing', 'paused', 'stopped']),
  positionMs: z.number().int().nonnegative().max(86_400_000),
});
const controlSchema = commandBase.extend({
  action: z.enum(['play', 'pause', 'next', 'previous', 'seek']),
  positionMs: z.number().int().nonnegative().max(86_400_000).optional(),
  reason: z.enum(['user', 'ended']).optional(),
}).superRefine((value, context) => {
  if (value.action === 'seek' && value.positionMs === undefined) {
    context.addIssue({ code: 'custom', message: 'positionMs is required for seek' });
  }
});
const queueRemoveSchema = commandBase.extend({ queueItemId: z.uuid() });

export function createSocketServer(
  httpServer: HttpServer,
  config: AppConfig,
  authService: AuthService | undefined,
  playbackService: PlaybackService | undefined,
  revocations?: SessionRevocationNotifier,
) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    path: '/socket.io',
    cors: {
      origin: config.PUBLIC_ORIGIN,
      credentials: true,
    },
    serveClient: false,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || origin === config.PUBLIC_ORIGIN);
    },
  });

  io.use(async (socket, next) => {
    try {
      if (!authService || !playbackService) return next(new Error('Service unavailable'));
      const token = parseCookie(socket.handshake.headers.cookie, sessionCookieName(config));
      const session = await authService.authenticate(token);
      const device = deviceSchema.safeParse(socket.handshake.auth);
      if (!session || !device.success) return next(new Error('Authentication required'));
      const registered = await playbackService.registerDevice({
        userId: session.response.user.id,
        deviceId: device.data.deviceId,
        name: device.data.deviceName,
        type: device.data.deviceType,
      });
      if (!registered) return next(new Error('Device unavailable'));
      socket.data.userId = session.response.user.id;
      socket.data.deviceId = device.data.deviceId;
      socket.data.sessionId = session.id;
      socket.data.sessionToken = token!;
      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  io.on('connection', (socket) => {
    const room = `user:${socket.data.userId}`;
    void socket.join(room);
    void emitSnapshot();
    const sessionCheck = setInterval(() => void ensureSession(), 15_000);
    socket.once('disconnect', () => clearInterval(sessionCheck));

    socket.on('playback:sync', () => void ensureSession().then((valid) => {
      if (valid) return emitSnapshot();
    }));
    socket.on('playback:claim', (command, ack) => void execute(claimSchema, command, ack, (value) =>
      playbackService!.claim({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));
    socket.on('playback:select', (command, ack) => void execute(selectSchema, command, ack, (value) =>
      playbackService!.select({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));
    socket.on('playback:select-context', (command, ack) => void execute(selectContextSchema, command, ack, (value) =>
      playbackService!.selectContext({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));
    socket.on('playback:update', (command, ack) => void execute(updateSchema, command, ack, (value) =>
      playbackService!.update({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));
    socket.on('playback:control', (command, ack) => void execute(controlSchema, command, ack, (value) =>
      playbackService!.control({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));
    socket.on('playback:queue-remove', (command, ack) => void execute(queueRemoveSchema, command, ack, (value) =>
      playbackService!.removeQueueItem({ ...value, userId: socket.data.userId, deviceId: socket.data.deviceId })));

    async function emitSnapshot(): Promise<void> {
      try {
        socket.emit('playback:snapshot', await playbackService!.snapshot(socket.data.userId));
      } catch {
        emitError('PLAYBACK_UNAVAILABLE', 'No pudimos recuperar tu hilo de reproducción.');
      }
    }

    async function execute<T>(
      schema: z.ZodType<T>,
      command: unknown,
      ack: PlaybackCommandAck | undefined,
      action: (value: T) => Promise<PlaybackCommandResult>,
    ): Promise<void> {
      const parsed = schema.safeParse(command);
      if (!parsed.success) return emitError('INVALID_COMMAND', 'El comando de reproducción no es válido.');
      try {
        if (!await ensureSession()) return;
        const result = await action(parsed.data);
        ack?.(result);
        io.to(room).emit('playback:snapshot', result.snapshot);
        if (result.status === 'conflict') {
          emitError('PLAYBACK_CONFLICT', 'El hilo cambió; se cargó el estado más reciente.');
        }
      } catch {
        emitError('PLAYBACK_CONFLICT', 'El hilo cambió; sincronizando el estado actual.');
        await emitSnapshot();
      }
    }

    async function ensureSession(): Promise<boolean> {
      const session = await authService?.authenticate(socket.data.sessionToken);
      if (session?.id === socket.data.sessionId) return true;
      emitError('UNAUTHENTICATED', 'La sesión terminó. Inicia sesión nuevamente.');
      socket.disconnect(true);
      return false;
    }

    function emitError(code: string, message: string): void {
      socket.emit('playback:error', { code, message });
    }
  });

  const stopSessionListener = revocations?.onSession((sessionId) => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === sessionId) socket.disconnect(true);
    }
  });
  const stopUserListener = revocations?.onUser((userId) => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === userId) socket.disconnect(true);
    }
  });
  io.engine.once('close', () => {
    stopSessionListener?.();
    stopUserListener?.();
  });

  return io;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return undefined; }
  }
  return undefined;
}
