import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import type {
  ClientToServerEvents,
  PlaybackCommandResult,
  PlaybackSnapshot,
  ServerToClientEvents,
  Track,
} from '@hirmos/contracts';
import { io, type Socket } from 'socket.io-client';
import { firstValueFrom } from 'rxjs';
import { AudioPlayerService } from './audio-player.service';
import { MediaSessionService } from './media-session.service';
import { SessionStore } from './session.store';

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

  readonly snapshot = signal<PlaybackSnapshot | null>(null);
  readonly connected = signal(false);
  private readonly snapshotFresh = signal(false);
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
      this.snapshotFresh.set(false);
      this.connected.set(true);
      this.error.set(null);
      this.socket.emit('playback:sync', { lastRevision: this.snapshot()?.revision ?? null });
    });
    this.socket.on('disconnect', () => {
      this.connected.set(false);
      this.snapshotFresh.set(false);
      if (this.leaseExpiry) clearTimeout(this.leaseExpiry);
      this.leaseExpiry = null;
      this.player.pause();
      this.mediaSession.clear();
    });
    this.socket.on('connect_error', (error) => {
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
      const ownsCurrentTrack = this.connected()
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
    if (!snapshot || !this.socket.connected) {
      this.error.set('El hilo todavía se está conectando. Inténtalo de nuevo.');
      return;
    }
    await this.issue((revision, ack) => this.socket.emit('playback:select', {
      commandId: crypto.randomUUID(),
      expectedRevision: revision,
      trackRef: track.id,
    }, ack));
  }

  public async selectContext(
    tracks: Track[],
    selectedIndex: number,
    contextType: 'album' | 'artist' | 'search' | 'home',
    contextRef: string | null,
  ): Promise<void> {
    if (!tracks.length || selectedIndex < 0 || selectedIndex >= tracks.length) return;
    tracks.forEach((track) => this.remember(track));
    if (!this.snapshot() || !this.socket.connected) {
      this.error.set('El hilo todavía se está conectando. Inténtalo de nuevo.');
      return;
    }
    await this.issue((revision, ack) => this.socket.emit('playback:select-context', {
      commandId: crypto.randomUUID(), expectedRevision: revision,
      trackRefs: tracks.map((track) => track.id), selectedIndex, contextType, contextRef,
    }, ack));
  }

  public async claimHere(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    await this.issue((revision, ack) => this.socket.emit('playback:claim', {
      commandId: crypto.randomUUID(),
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
    await this.issue((revision, ack) => this.socket.emit('playback:queue-remove', {
      commandId: crypto.randomUUID(),
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
    if (!snapshot || !this.socket.connected) return;
    await this.issue((revision, ack) => this.socket.emit('playback:control', {
      commandId: crypto.randomUUID(),
      expectedRevision: revision,
      action,
      reason,
      ...(positionMs === undefined ? {} : { positionMs }),
    }, ack));
  }

  private async publishState(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !this.ownsLease(snapshot) || !this.socket.connected) return;
    // Loading is not evidence of either playback or pause. Wait for actual
    // progress or a terminal recovery failure before changing durable state.
    if (this.player.requested() && !this.player.playing()
      && ['loading', 'buffering'].includes(this.player.phase())) return;
    await this.sendCommand((ack) => this.socket.emit('playback:update', {
      commandId: crypto.randomUUID(),
      expectedRevision: snapshot.revision,
      leaseEpoch: snapshot.leaseEpoch,
      status: this.player.playing() ? 'playing' : 'paused',
      positionMs: Math.max(0, Math.round(this.player.positionSeconds() * 1_000)),
    }, ack));
  }

  private async issue(
    emit: (revision: number, ack: (result: PlaybackCommandResult) => void) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revision = this.snapshot()?.revision;
      if (revision === undefined) return;
      const result = await this.sendCommand((ack) => emit(revision, ack));
      if (!result) return;
      if (result.status !== 'conflict') return;
    }
    this.error.set('El hilo siguió cambiando en otro dispositivo. Inténtalo nuevamente.');
  }

  private async sendCommand(
    emit: (ack: (result: PlaybackCommandResult) => void) => void,
  ): Promise<PlaybackCommandResult | null> {
    const result = await new Promise<PlaybackCommandResult | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 6_000);
      emit((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    if (!result) {
      this.error.set('El servidor no confirmó el comando.');
      return null;
    }
    this.receive(result.snapshot);
    if (result.status !== 'conflict') this.error.set(null);
    return result;
  }

  private async loadQueueTracks(snapshot: PlaybackSnapshot): Promise<void> {
    const references = [snapshot.currentTrackRef, ...snapshot.queue.map((item) => item.trackRef)]
      .filter((reference): reference is string => Boolean(reference));
    const unique = [...new Set(references)];
    for (let index = 0; index < unique.length; index += 4) {
      await Promise.all(unique.slice(index, index + 4).map((reference) => this.loadTrack(reference)));
    }
    this.queueTracks.set(Object.fromEntries(
      snapshot.queue.flatMap((item) => {
        const track = this.tracks.get(item.trackRef);
        return track ? [[item.trackRef, track]] : [];
      }),
    ));
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
