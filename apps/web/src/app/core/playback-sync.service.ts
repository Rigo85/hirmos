import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import type {
  ClientToServerEvents,
  PlaybackClientDiagnostic,
  PlaybackCommandName,
  PlaybackCommandResult,
  PlaybackSnapshot,
  ResolveTracksResponse,
  ServerToClientEvents,
  Track,
} from '@hirmos/contracts';
import { io, type Socket } from 'socket.io-client';
import { firstValueFrom } from 'rxjs';
import { AudioPlayerService } from './audio-player.service';
import { MediaSessionService } from './media-session.service';
import { SessionStore } from './session.store';
import { deliverWithAckRetry } from './playback-command-delivery';

type ControlAction = 'play' | 'pause' | 'next' | 'previous' | 'seek';

@Injectable({ providedIn: 'root' })
export class PlaybackSyncService {
  private readonly http = inject(HttpClient);
  private readonly player = inject(AudioPlayerService);
  private readonly mediaSession = inject(MediaSessionService);
  private readonly sessionStore = inject(SessionStore);
  private readonly deviceId = playerInstanceId(this.sessionStore.session()?.user.id);
  private readonly tracks = new Map<string, Track>();
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private readonly trackLoads = new Map<string, Promise<Track | null>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private leaseExpiry: ReturnType<typeof setTimeout> | null = null;
  private reconcileSequence = 0;
  private publishInFlight = false;
  private readonly pendingDiagnostics: PlaybackClientDiagnostic[] = [];

  readonly snapshot = signal<PlaybackSnapshot | null>(null);
  readonly connected = signal(false);
  private readonly snapshotFresh = signal(false);
  private readonly terminalSocketStop = signal(false);
  readonly error = signal<string | null>(null);
  readonly queueTracks = signal<Record<string, Track>>({});

  public constructor() {
    this.socket = io({
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket', 'polling'],
      auth: {
        deviceId: this.deviceId,
        deviceName: deviceName(),
        deviceType: deviceType(),
      },
    });
    this.socket.on('connect', () => {
      this.terminalSocketStop.set(false);
      this.connected.set(true);
      this.error.set(null);
      this.flushDiagnostics();
      this.socket.emit('playback:sync', { lastRevision: this.snapshot()?.revision ?? null });
    });
    this.socket.on('disconnect', (reason) => {
      this.connected.set(false);
      this.recordDiagnostic({ kind: 'disconnect', reason });
      if (isTerminalPlaybackDisconnect(reason)) {
        this.stopForTerminalDisconnect();
      }
    });
    this.socket.on('connect_error', (error) => {
      this.recordDiagnostic({ kind: 'connect_error', reason: error.message });
      if (error.message === 'Authentication required') this.stopForTerminalDisconnect();
      this.error.set(error.message === 'Authentication required'
        ? 'Tu sesión terminó. Inicia sesión nuevamente.'
        : 'No pudimos conectar tus dispositivos.');
    });
    this.socket.on('playback:error', (error) => this.error.set(error.message));
    this.socket.on('playback:snapshot', (snapshot) => this.receive(snapshot));
    this.player.onEnded(() => {
      if (this.ownsLease()) void this.control('next', undefined, 'ended');
    });
    this.player.onPlaybackStarted(() => void this.publishState());
    this.player.onPlaybackFailed((message) => {
      this.error.set(message);
      void this.publishState().finally(() => {
        if (this.player.phase() === 'error') this.error.set(message);
      });
    });
    this.registerMediaSession();
    effect(() => {
      const snapshot = this.snapshot();
      const track = this.player.track();
      const ownsCurrentTrack = !this.terminalSocketStop()
        && this.snapshotFresh()
        && this.ownsLease(snapshot)
        && Boolean(track)
        && snapshot?.currentTrackRef === track?.id;
      this.mediaSession.synchronize({
        active: ownsCurrentTrack,
        track: ownsCurrentTrack ? track : null,
        playing: this.player.playing(),
        positionSeconds: this.player.positionSeconds(),
        durationSeconds: this.player.durationSeconds() || (track?.durationMs ?? 0) / 1_000,
      });
    });
    this.connect();
  }

  public connect(): void {
    if (!this.socket.connected) this.socket.connect();
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => void this.publishState(), 10_000);
    }
  }

  public async select(track: Track): Promise<void> {
    this.remember(track);
    const snapshot = this.snapshot();
    if (!snapshot || this.terminalSocketStop()) {
      this.error.set('El hilo todavía se está conectando. Inténtalo de nuevo.');
      return;
    }
    await this.issue('select', (revision, commandId, ack) => this.socket.emit('playback:select', {
      commandId,
      expectedRevision: revision,
      trackRef: track.id,
    }, ack));
  }

  public async selectContext(
    tracks: Track[],
    selectedIndex: number,
    contextType: 'album' | 'artist' | 'search' | 'home' | 'genre' | 'favorites',
    contextRef: string | null,
  ): Promise<void> {
    if (!tracks.length || selectedIndex < 0 || selectedIndex >= tracks.length) return;
    tracks.forEach((track) => this.remember(track));
    if (!this.snapshot() || this.terminalSocketStop()) {
      this.error.set('El hilo todavía se está conectando. Inténtalo de nuevo.');
      return;
    }
    await this.issue('select-context', (revision, commandId, ack) => this.socket.emit('playback:select-context', {
      commandId, expectedRevision: revision,
      trackRefs: tracks.map((track) => track.id), selectedIndex, contextType, contextRef,
    }, ack));
  }

  public async claimHere(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    await this.issue('claim', (revision, commandId, ack) => this.socket.emit('playback:claim', {
      commandId,
      expectedRevision: revision,
    }, ack));
  }

  public async toggle(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot?.currentTrackRef) return;
    await this.control(snapshot.status === 'playing' ? 'pause' : 'play');
  }

  public next(): Promise<void> {
    return this.control('next');
  }

  public previous(): Promise<void> {
    return this.control('previous');
  }

  public seek(seconds: number): Promise<void> {
    return this.control('seek', Math.max(0, Math.round(seconds * 1_000)));
  }

  public async removeQueueItem(queueItemId: string): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    await this.issue('queue-remove', (revision, commandId, ack) => this.socket.emit('playback:queue-remove', {
      commandId,
      expectedRevision: revision,
      queueItemId,
    }, ack));
  }

  public trackFor(reference: string): Track | null {
    return this.queueTracks()[reference] ?? this.tracks.get(reference) ?? null;
  }

  public disconnect(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.leaseExpiry) clearTimeout(this.leaseExpiry);
    this.leaseExpiry = null;
    this.terminalSocketStop.set(true);
    this.snapshotFresh.set(false);
    this.socket.disconnect();
    this.snapshot.set(null);
    this.player.pause();
    this.mediaSession.clear();
  }

  public ownsLease(snapshot = this.snapshot()): boolean {
    if (!snapshot?.leaseExpiresAt) return false;
    return snapshot.activeDeviceId === this.deviceId
      && Date.parse(snapshot.leaseExpiresAt) > Date.now();
  }

  public hasActiveRemotePlayer(snapshot = this.snapshot()): boolean {
    if (!snapshot?.activeDeviceId || !snapshot.leaseExpiresAt) return false;
    return snapshot.activeDeviceId !== this.deviceId
      && Date.parse(snapshot.leaseExpiresAt) > Date.now();
  }

  public currentPositionSeconds(now = Date.now()): number {
    const snapshot = this.snapshot();
    if (!snapshot?.currentTrackRef) return 0;
    if (this.ownsLease(snapshot) && this.player.track()?.id === snapshot.currentTrackRef) {
      return this.player.positionSeconds();
    }
    return estimatedPositionSeconds(snapshot, now);
  }

  private receive(snapshot: PlaybackSnapshot): void {
    this.snapshot.set(snapshot);
    this.snapshotFresh.set(true);
    this.scheduleLeaseExpiry(snapshot);
    void this.reconcile(snapshot, ++this.reconcileSequence);
    void this.loadQueueTracks(snapshot);
  }

  private async reconcile(snapshot: PlaybackSnapshot, sequence: number): Promise<void> {
    if (!this.ownsLease(snapshot)) {
      this.player.pause();
      return;
    }
    if (!snapshot.currentTrackRef) {
      this.player.pause();
      return;
    }
    const track = await this.loadTrack(snapshot.currentTrackRef);
    if (!track || sequence !== this.reconcileSequence) return;
    const changedTrack = this.player.track()?.id !== track.id;
    if (changedTrack) this.player.load(track);
    const expectedSeconds = estimatedPositionSeconds(snapshot);
    // Starting close to zero should not force a Range restart while metadata is
    // still arriving. Transfers and genuine drift still seek immediately.
    if ((changedTrack && expectedSeconds > 5)
      || (!changedTrack && Math.abs(this.player.positionSeconds() - expectedSeconds) > 2)) {
      this.player.seek(expectedSeconds);
    }
    if (snapshot.status === 'playing' && !this.player.requested()) {
      await this.player.resume();
    } else if (snapshot.status !== 'playing') {
      // A freshly loaded, already-paused HTMLAudioElement may not emit a pause
      // event. Apply the durable state explicitly so neither the UI nor Media
      // Session remains stuck in a synthetic loading phase after a reload.
      this.player.pause();
    }
  }

  private async control(
    action: ControlAction,
    positionMs?: number,
    reason: 'user' | 'ended' = 'user',
  ): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || this.terminalSocketStop()) return;
    await this.issue('control', (revision, commandId, ack) => this.socket.emit('playback:control', {
      commandId,
      expectedRevision: revision,
      action,
      reason,
      ...(positionMs === undefined ? {} : { positionMs }),
    }, ack));
  }

  private async publishState(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !this.ownsLease(snapshot) || !this.socket.connected || this.publishInFlight) return;
    // Loading is not evidence of either playback or pause. Wait for actual
    // progress or a terminal recovery failure before changing durable state.
    if (this.player.requested() && !this.player.playing()
      && ['loading', 'buffering'].includes(this.player.phase())) return;
    const commandId = crypto.randomUUID();
    this.publishInFlight = true;
    try {
      await this.sendCommand('update', commandId, (ack) => this.socket.emit('playback:update', {
        commandId,
        expectedRevision: snapshot.revision,
        leaseEpoch: snapshot.leaseEpoch,
        status: this.player.playing() ? 'playing' : 'paused',
        positionMs: Math.max(0, Math.round(this.player.positionSeconds() * 1_000)),
      }, ack), false);
    } finally {
      this.publishInFlight = false;
    }
  }

  private async issue(
    command: PlaybackCommandName,
    emit: (
      revision: number,
      commandId: string,
      ack: (result: PlaybackCommandResult) => void,
    ) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revision = this.snapshot()?.revision;
      if (revision === undefined) return;
      const commandId = crypto.randomUUID();
      const result = await this.sendCommand(
        command,
        commandId,
        (ack) => emit(revision, commandId, ack),
        true,
      );
      if (!result) return;
      if (result.error) return;
      if (result.status !== 'conflict') return;
    }
    this.error.set('El hilo siguió cambiando en otro dispositivo. Inténtalo nuevamente.');
  }

  private async sendCommand(
    command: PlaybackCommandName,
    commandId: string,
    emit: (ack: (result: PlaybackCommandResult) => void) => void,
    interactive: boolean,
  ): Promise<PlaybackCommandResult | null> {
    const result = await deliverWithAckRetry(emit, {
      attempts: 2,
      ackTimeoutMs: 6_000,
      waitUntilReady: (timeoutMs) => this.waitUntilSocketReady(timeoutMs),
      onTimeout: (_attempt, elapsedMs) => this.recordDiagnostic({
        kind: 'ack_timeout', command, commandId, elapsedMs,
      }),
    });
    if (!result) {
      if (interactive) {
        this.error.set('No pudimos confirmar el comando. Reconectando el hilo…');
        if (this.socket.connected) {
          this.socket.emit('playback:sync', { lastRevision: this.snapshot()?.revision ?? null });
        }
      }
      return null;
    }
    this.receive(result.snapshot);
    if (result.error) {
      this.error.set(result.error.message);
    } else if (result.status !== 'conflict') {
      this.error.set(null);
    }
    return result;
  }

  private waitUntilSocketReady(timeoutMs: number): Promise<boolean> {
    if (this.socket.connected) return Promise.resolve(true);
    if (this.terminalSocketStop()) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.socket.off('connect', onConnect);
        this.socket.off('disconnect', onDisconnect);
        resolve(ready);
      };
      const onConnect = () => finish(true);
      const onDisconnect = (reason: string) => {
        if (isTerminalPlaybackDisconnect(reason)) finish(false);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.socket.on('connect', onConnect);
      this.socket.on('disconnect', onDisconnect);
    });
  }

  private stopForTerminalDisconnect(): void {
    this.terminalSocketStop.set(true);
    this.snapshotFresh.set(false);
    if (this.leaseExpiry) clearTimeout(this.leaseExpiry);
    this.leaseExpiry = null;
    this.player.pause();
    this.mediaSession.clear();
  }

  private recordDiagnostic(
    diagnostic: Omit<PlaybackClientDiagnostic, 'occurredAt'>,
  ): void {
    const value: PlaybackClientDiagnostic = {
      ...diagnostic,
      occurredAt: new Date().toISOString(),
    };
    if (this.socket.connected) {
      this.socket.emit('playback:diagnostic', value);
      return;
    }
    this.pendingDiagnostics.push(value);
    if (this.pendingDiagnostics.length > 20) this.pendingDiagnostics.shift();
  }

  private flushDiagnostics(): void {
    for (const diagnostic of this.pendingDiagnostics.splice(0)) {
      this.socket.emit('playback:diagnostic', diagnostic);
    }
  }

  private async loadQueueTracks(snapshot: PlaybackSnapshot): Promise<void> {
    const references = [snapshot.currentTrackRef, ...snapshot.queue.map((item) => item.trackRef)]
      .filter((reference): reference is string => Boolean(reference));
    const unique = [...new Set(references)];
    await this.loadTracks(unique);
    if (this.snapshot()?.revision !== snapshot.revision) return;
    this.queueTracks.set(Object.fromEntries(
      snapshot.queue.flatMap((item) => {
        const track = this.tracks.get(item.trackRef);
        return track ? [[item.trackRef, track]] : [];
      }),
    ));
  }

  private async loadTracks(references: string[]): Promise<void> {
    const pending: Promise<Track | null>[] = [];
    const missing: string[] = [];
    for (const reference of references) {
      if (this.tracks.has(reference)) continue;
      const existing = this.trackLoads.get(reference);
      if (existing) pending.push(existing);
      else missing.push(reference);
    }
    if (missing.length) {
      const batch = firstValueFrom(this.http.post<ResolveTracksResponse>(
        '/api/music/tracks/resolve', { references: missing },
      )).then((response) => {
        this.rememberMany(response.tracks);
        const tracks = new Map(response.tracks.map((track) => [track.id, track]));
        if (tracks.size < missing.length) {
          this.error.set('No pudimos recuperar algunas canciones de la cola.');
        }
        return tracks;
      }).catch(() => {
        this.error.set('No pudimos recuperar algunas canciones de la cola.');
        return new Map<string, Track>();
      });
      for (const reference of missing) {
        let load!: Promise<Track | null>;
        load = batch.then((tracks) => tracks.get(reference) ?? null)
          .finally(() => {
            if (this.trackLoads.get(reference) === load) this.trackLoads.delete(reference);
          });
        this.trackLoads.set(reference, load);
        pending.push(load);
      }
    }
    await Promise.all(pending);
  }

  private async loadTrack(reference: string): Promise<Track | null> {
    const known = this.tracks.get(reference);
    if (known) return known;
    const pending = this.trackLoads.get(reference);
    if (pending) return pending;
    const load = firstValueFrom(
      this.http.get<Track>(`/api/music/tracks/${encodeURIComponent(reference)}`),
    ).then((track) => {
      this.remember(track);
      return track;
    }).catch(() => {
      this.error.set('No pudimos recuperar una canción de la cola.');
      return null;
    }).finally(() => this.trackLoads.delete(reference));
    this.trackLoads.set(reference, load);
    return load;
  }

  private remember(track: Track): void {
    this.tracks.set(track.id, track);
    this.queueTracks.set({ ...this.queueTracks(), [track.id]: track });
  }

  private rememberMany(tracks: Track[]): void {
    if (!tracks.length) return;
    const additions: Record<string, Track> = {};
    for (const track of tracks) {
      this.tracks.set(track.id, track);
      additions[track.id] = track;
    }
    this.queueTracks.set({ ...this.queueTracks(), ...additions });
  }

  private registerMediaSession(): void {
    this.mediaSession.registerHandlers({
      play: () => void this.control('play'),
      pause: () => void this.control('pause'),
      next: () => void this.control('next'),
      previous: () => void this.control('previous'),
      seekTo: (seconds) => void this.seek(seconds),
      seekBy: (seconds) => {
        const duration = this.player.durationSeconds();
        const target = this.player.positionSeconds() + seconds;
        void this.seek(duration > 0 ? Math.min(duration, Math.max(0, target)) : Math.max(0, target));
      },
    });
  }

  private scheduleLeaseExpiry(snapshot: PlaybackSnapshot): void {
    if (this.leaseExpiry) clearTimeout(this.leaseExpiry);
    this.leaseExpiry = null;
    if (snapshot.activeDeviceId !== this.deviceId || !snapshot.leaseExpiresAt) return;
    const delay = Math.max(0, Date.parse(snapshot.leaseExpiresAt) - Date.now()) + 50;
    this.leaseExpiry = setTimeout(() => {
      this.leaseExpiry = null;
      if (this.ownsLease()) return;
      this.player.pause();
      this.mediaSession.clear();
    }, delay);
  }
}

function playerInstanceId(userId: string | undefined): string {
  const key = `hirmos.player-id:${userId ?? 'anonymous'}`;
  const existing = sessionStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

function deviceName(): string {
  return deviceType() === 'mobile' ? 'Teléfono' : 'Navegador de escritorio';
}

function deviceType(): 'desktop' | 'mobile' | 'tablet' {
  if (matchMedia('(max-width: 760px)').matches) return 'mobile';
  if (matchMedia('(max-width: 1050px)').matches) return 'tablet';
  return 'desktop';
}

export function estimatedPositionSeconds(snapshot: PlaybackSnapshot, now = Date.now()): number {
  const anchor = snapshot.positionMs / 1_000;
  if (snapshot.status !== 'playing') return anchor;
  return anchor + Math.max(0, now - Date.parse(snapshot.positionObservedAt)) / 1_000;
}

export function isTerminalPlaybackDisconnect(reason: string): boolean {
  return reason === 'io server disconnect' || reason === 'io client disconnect';
}
