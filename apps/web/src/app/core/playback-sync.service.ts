import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type {
  PlaybackAnchor,
  PlaybackFailure,
  PlaybackFailureCode,
  PlaybackFailureNotice,
  ClientToServerEvents,
  PlaybackClientDiagnostic,
  PlaybackCommandName,
  PlaybackCommandResult,
  PlaybackSnapshot,
  ResolveTracksResponse,
  ServerToClientEvents,
  Track,
  MusicLookupFailure,
} from '@hirmos/contracts';
import { PLAYBACK_PROTOCOL_VERSION } from '@hirmos/contracts/playback-protocol';
import { io, type Socket } from 'socket.io-client';
import { firstValueFrom, from, timeout, retry, timer, throwError } from 'rxjs';
import { AudioPlayerService } from './audio-player.service';
import { MediaSessionService } from './media-session.service';
import { SessionStore } from './session.store';
import { deliverWithAckRetry } from './playback-command-delivery';
import { acceptsSnapshot, playbackAnchor, samePlaybackAnchor, PlaybackCommandSequencer } from './playback-consistency';

type ControlAction = 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'retry';

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
  private readonly commands = new PlaybackCommandSequencer();
  private appliedAnchor: PlaybackAnchor | null = null;
  private pendingEndInstance: string | null = null;
  private pendingEnd: { anchor: PlaybackAnchor; positionMs: number } | null = null;
  private finishing = false;
  private retryEndAfterSync = false;
  private terminalAnchor: PlaybackAnchor | null = null;
  private interactionAnchor: PlaybackAnchor | null = null;
  private continuation: { anchor: PlaybackAnchor; revision: number } | null = null;
  readonly permissionStillBlocked = signal(false);
  readonly continuingAudio = signal(false);
  private pendingFailure: { anchor: PlaybackAnchor; failure: PlaybackFailure } | null = null;
  private failureInFlight = false;
  private failureResyncs = 0;
  private retryFailureAfterDelivery = false;
  readonly unconfirmedFailure = signal<PlaybackFailure | null>(null);
  readonly authenticationRequired = signal(false);
  private loadingAnchor: PlaybackAnchor | null = null;
  private readonly metadataFailures = new Map<string, { code: PlaybackFailureCode; retryAfterMs?: number; retryAt?: number }>();
  readonly failureDetailsOpen = signal(false);
  readonly dismissedFailure = signal<string | null>(null);
  readonly retryWaitSeconds = signal(0);
  private retryWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingDiagnostics: PlaybackClientDiagnostic[] = [];

  readonly snapshot = signal<PlaybackSnapshot | null>(null);
  readonly waitingForAudio = computed(() => this.snapshot()?.renderPhase === 'awaiting_interaction');
  readonly connected = signal(false);
  private readonly snapshotFresh = signal(false);
  private readonly terminalSocketStop = signal(false);
  readonly error = signal<string | null>(null);
  readonly queueTracks = signal<Record<string, Track>>({});

  public constructor() {
    let dismissalScope = this.dismissalKey();
    try { this.dismissedFailure.set(localStorage.getItem(this.dismissalKey())); } catch { /* optional preference */ }
    effect(() => {
      const scope = this.dismissalKey();
      if (scope !== dismissalScope) {
        dismissalScope = scope;
        let saved: string | null = null;
        try { saved = localStorage.getItem(scope); } catch { /* optional preference */ }
        this.dismissedFailure.set(saved);
        return;
      }
      const id = this.dismissedFailure();
      if (id) { try { localStorage.setItem(this.dismissalKey(), id); } catch { /* keep in memory */ } }
    });
    this.socket = io({
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket', 'polling'],
      auth: {
        protocolVersion: PLAYBACK_PROTOCOL_VERSION,
        deviceId: this.deviceId,
        deviceName: deviceName(),
        deviceType: deviceType(),
      },
    });
    this.socket.on('connect', () => {
      this.authenticationRequired.set(false);
      this.terminalSocketStop.set(false);
      this.connected.set(true);
      this.error.set(null);
      this.flushDiagnostics();
      this.retryEndAfterSync = true;
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
      if (error.message === 'Playback client update required') {
        this.stopForTerminalDisconnect();
        this.socket.disconnect();
        this.error.set('Hay una actualización del reproductor. Recarga Hirmos para continuar.');
        return;
      }
      if (error.message === 'Authentication required') {
        this.authenticationRequired.set(true);
        this.stopForTerminalDisconnect();
      }
      this.error.set(error.message === 'Authentication required'
        ? 'Tu sesión terminó. Inicia sesión nuevamente.'
        : 'No pudimos conectar tus dispositivos.');
    });
    this.socket.on('playback:error', (error) => {
      if (error.code === 'UNAUTHENTICATED') this.authenticationRequired.set(true);
      this.error.set(error.message);
    });
    this.socket.on('playback:snapshot', (snapshot) => this.receive(snapshot));
    this.player.onEnded(() => {
      if (this.ownsLease() && this.appliedAnchor) {
        this.pendingEndInstance = this.appliedAnchor.playbackInstanceId;
        this.pendingEnd = { anchor: this.appliedAnchor,
          positionMs: Math.round(this.player.positionSeconds() * 1_000) };
        void this.finishPendingEnd();
      }
    });
    this.player.onPlaybackStarted(() => void this.publishState());
    this.player.onInteractionRequired(() => {
      if (!this.appliedAnchor || !this.ownsLease()) return;
      this.permissionStillBlocked.set(Boolean(this.continuation));
      if (!this.interactionAnchor || !samePlaybackAnchor(this.interactionAnchor, this.appliedAnchor)) {
        this.recordDiagnostic({ kind: 'audio_permission', reason: 'NotAllowedError' });
      }
      this.interactionAnchor = this.appliedAnchor;
      void this.publishState();
    });
    this.player.onRecoveryCheck(async requestId => {
      if (navigator.onLine === false) return { code: 'offline' };
      try {
        return await firstValueFrom(this.http.get<Pick<PlaybackFailure, 'code' | 'retryAfterMs'> | null>(
          `/api/music/playback-failures/${encodeURIComponent(requestId)}`).pipe(timeout(1_500)));
      } catch (error) {
        const failure = metadataFailure(error as MetadataHttpError);
        return ['authentication', 'service_unavailable'].includes(failure.code) ? failure : null;
      }
    });
    this.player.onPlaybackFailed((message, failure) => {
      this.error.set(message);
      if (this.appliedAnchor) void this.reportFailure(this.appliedAnchor,
        failure ?? { code: 'unknown', phase: 'stream', positionMs: Math.round(this.player.positionSeconds()*1000), elapsedMs: 0 },
        failure?.requestId);
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
    const trackRefs = tracks.map((track) => track.id);
    if (!this.snapshot() || this.terminalSocketStop()) {
      this.error.set('El hilo todavía se está conectando. Inténtalo de nuevo.');
      return;
    }
    await this.issue('select-context', (revision, commandId, ack) => this.socket.emit('playback:select-context', {
      commandId, expectedRevision: revision,
      trackRefs, selectedIndex, contextType, contextRef,
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
    if (this.waitingForAudio()) return this.continueAudio();
    if (this.unconfirmedFailure() || ['error','blocked'].includes(snapshot.renderPhase)) return this.retryCurrent();
    await this.control(snapshot.status === 'playing' ? 'pause' : 'play');
  }

  public async continueAudio(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !this.waitingForAudio() || this.continuingAudio()
      || !this.connected() || !this.snapshotFresh() || this.authenticationRequired()) return;
    if (!this.ownsLease()) {
      // A click in a remote browser cannot grant permission to another one.
      if (!this.hasActiveRemotePlayer()) await this.control('play');
      return;
    }
    const anchor = playbackAnchor(snapshot);
    if (!this.appliedAnchor || !samePlaybackAnchor(anchor, this.appliedAnchor)
      || this.player.track()?.id !== snapshot.currentTrackRef) return;
    const continuation = { anchor, revision: snapshot.revision };
    this.continuation = continuation;
    this.continuingAudio.set(true);
    this.permissionStillBlocked.set(false);
    try {
      // Call native play synchronously within the gesture on the prepared source.
      // Ownership is already confirmed. Never use a muted/empty unlock probe.
      await this.player.resume();
      if (this.continuation !== continuation || !this.ownsLease()
        || !samePlaybackAnchor(anchor, playbackAnchor(this.snapshot()!))) return;
      if (this.player.phase() === 'awaiting_interaction') return;
      if (!this.player.requested()) return;
      const commandId = crypto.randomUUID();
      const result = await this.sendCommand('control', commandId, ack => this.socket.emit('playback:control', {
        commandId, expectedRevision: continuation.revision, anchor, action: 'play',
      }, ack), false);
      if ((!result || result.status === 'conflict') && this.continuation === continuation) {
        this.player.pause();
      }
    } finally {
      if (this.continuation === continuation) {
        this.continuation = null;
        this.continuingAudio.set(false);
        if (this.snapshot()) void this.reconcile(this.snapshot()!, ++this.reconcileSequence);
      }
      void this.publishState();
    }
  }

  public next(): Promise<void> {
    return this.control('next');
  }

  private dismissalKey(): string {
    return `hirmos.dismissed-incident.v1:${this.sessionStore.session()?.user.id ?? 'anonymous'}`;
  }

  private refreshRetryWait(minimumMs = 0): void {
    if (this.retryWaitTimer) clearTimeout(this.retryWaitTimer);
    this.retryWaitTimer = null;
    const snapshot = this.snapshot();
    const notice = snapshot?.failures.at(-1);
    const deadline = notice?.retryAfterMs ? Date.parse(notice.occurredAt) + notice.retryAfterMs : 0;
    const remaining = snapshot && ['error', 'blocked'].includes(snapshot.renderPhase)
      && notice?.trackRef === snapshot.currentTrackRef
      ? Math.max(minimumMs, Number.isFinite(deadline) ? deadline - Date.now() : 0, 0) : 0;
    this.retryWaitSeconds.set(Math.ceil(remaining / 1_000));
    // Only tick during an actual cooldown. Recompute from the absolute deadline
    // after suspension/reload; never restart the wait on a heartbeat.
    if (remaining > 0) this.retryWaitTimer = setTimeout(() => this.refreshRetryWait(), Math.min(1_000, remaining));
  }

  public async retryCurrent(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    const anchor = playbackAnchor(snapshot);
    if (navigator.onLine === false) { this.error.set('Recupera la conexión antes de reintentar.'); return; }
    if (this.authenticationRequired()) { this.error.set('Inicia sesión nuevamente para continuar.'); return; }
    if (this.unconfirmedFailure()) {
      await this.retryFailureReport();
      const current = this.snapshot();
      if (this.unconfirmedFailure() || !current || !samePlaybackAnchor(anchor, playbackAnchor(current))) return;
    }
    this.refreshRetryWait();
    if (this.retryWaitSeconds() > 0) return;
    const latest = this.snapshot()?.failures.at(-1);
    if (latest?.code === 'autoplay' && !this.ownsLease()) {
      this.error.set('Habilita el audio en el dispositivo que está reproduciendo, o elige Reproducir aquí.');
      return;
    }
    return this.control('retry', undefined, 'user', anchor);
  }

  public async retryFailureReport(): Promise<void> {
    if (!this.socket.connected) { this.connect(); return; }
    await this.flushFailure();
  }

  public failureText(notice: PlaybackFailureNotice): string {
    const title = this.trackFor(notice.trackRef)?.title ?? 'una canción';
    const reason: Record<PlaybackFailureCode,string> = {
      network: 'falló la conexión de audio', timeout: 'el audio no avanzó', decode: 'no se pudo decodificar el audio',
      unsupported: 'este navegador no pudo abrir el audio', not_found: 'el contenido no está disponible',
      unknown: 'no pudimos determinar la causa', autoplay: 'el reproductor necesita un toque para habilitar el audio',
      authentication: 'la sesión necesita autenticación', service_unavailable: 'el servicio musical no está disponible',
      offline: 'el dispositivo está sin conexión',
    };
    return `${notice.outcome === 'advanced' ? 'Omitimos' : 'No pudimos continuar con'} «${title}»: ${reason[notice.code]}.`
      + (notice.outcome === 'limit' ? ' Detuvimos los saltos para no recorrer toda la cola.' : '');
  }

  private async reportFailure(anchor: PlaybackAnchor, failure: PlaybackFailure, requestId?: string | null): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || snapshot.status === 'stopped' || !this.ownsLease(snapshot) || !samePlaybackAnchor(anchor,playbackAnchor(snapshot))) return;
    if (this.terminalAnchor && samePlaybackAnchor(anchor,this.terminalAnchor)) return;
    this.terminalAnchor = anchor;
    this.unconfirmedFailure.set(failure);
    this.failureResyncs = 0;
    this.player.pause();
    let code = failure.code;
    let retryAfterMs = failure.retryAfterMs;
    if (navigator.onLine === false) code = 'offline';
    else if (requestId && !['autoplay','authentication'].includes(code)) {
      try {
        const diagnosis = await firstValueFrom(this.http.get<{code: PlaybackFailureCode; retryAfterMs?: number} | null>(
          `/api/music/playback-failures/${encodeURIComponent(requestId)}`).pipe(timeout(1_500)));
        if (diagnosis?.code && diagnosis.code !== 'unknown') code = diagnosis.code;
        retryAfterMs = diagnosis?.retryAfterMs ?? retryAfterMs;
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403) code = 'authentication';
        else if (status === 429 || status === 503) code = 'service_unavailable';
        // Other diagnostic failures cannot establish why the stream failed.
      }
    }
    if (!this.snapshot() || this.snapshot()!.status === 'stopped'
      || !samePlaybackAnchor(anchor,playbackAnchor(this.snapshot()!))) return;
    this.pendingFailure = { anchor, failure: { code, phase: failure.phase,
      positionMs: failure.positionMs, elapsedMs: failure.elapsedMs,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(86_400_000, Math.max(0, retryAfterMs)) }) } };
    this.unconfirmedFailure.set(this.pendingFailure.failure);
    if (code === 'authentication') this.authenticationRequired.set(true);
    await this.flushFailure();
  }

  private async flushFailure(): Promise<void> {
    const pending = this.pendingFailure;
    if (!pending || this.failureInFlight || !this.socket.connected || !this.ownsLease()) return;
    this.failureInFlight = true;
    try {
      await this.issue('failure', (revision,commandId,ack) => this.socket.emit('playback:failure', {
        commandId, expectedRevision: revision, anchor: pending.anchor, failure: pending.failure,
      },ack),pending.anchor);
    } finally {
      this.failureInFlight = false;
      const retry = this.retryFailureAfterDelivery;
      this.retryFailureAfterDelivery = false;
      if (this.pendingFailure && (this.pendingFailure !== pending || retry)) void this.flushFailure();
    }
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
    this.refreshRetryWait();
    this.appliedAnchor = null;
    this.pendingEndInstance = null;
    this.pendingEnd = null;
    this.pendingFailure = null;
    this.unconfirmedFailure.set(null);
    this.terminalAnchor = null;
    this.loadingAnchor = null;
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
    if (snapshot.protocolVersion !== PLAYBACK_PROTOCOL_VERSION) {
      this.stopForTerminalDisconnect();
      this.error.set('La versión del reproductor cambió. Recarga Hirmos.');
      return;
    }
    if (!acceptsSnapshot(this.snapshot(), snapshot)) return;
    if (this.snapshot()?.renderPhase === 'awaiting_interaction' && snapshot.renderPhase !== 'awaiting_interaction') {
      this.interactionAnchor = null;
      this.permissionStillBlocked.set(false);
    }
    if (this.terminalAnchor && (snapshot.status === 'stopped'
      || !samePlaybackAnchor(this.terminalAnchor,playbackAnchor(snapshot)))) {
      this.terminalAnchor = null; this.pendingFailure = null;
      this.unconfirmedFailure.set(null);
    }
    if (['error','blocked'].includes(snapshot.renderPhase)) {
      this.pendingFailure = null;
      this.unconfirmedFailure.set(null);
    }
    if (snapshot.playbackInstanceId !== this.pendingEndInstance || snapshot.status !== 'playing') {
      this.pendingEndInstance = null;
      this.pendingEnd = null;
    }
    this.snapshot.set(snapshot);
    this.refreshRetryWait();
    this.snapshotFresh.set(true);
    this.scheduleLeaseExpiry(snapshot);
    void this.reconcile(snapshot, ++this.reconcileSequence);
    void this.loadQueueTracks(snapshot);
    if (this.retryEndAfterSync) {
      this.retryEndAfterSync = false;
      void this.finishPendingEnd();
      if (this.failureInFlight) this.retryFailureAfterDelivery = true;
      else void this.flushFailure();
    }
  }

  private async finishPendingEnd(): Promise<void> {
    const end = this.pendingEnd;
    if (!end || this.finishing || !this.ownsLease()) return;
    this.finishing = true;
    try { await this.control('next', end.positionMs, 'ended', end.anchor); }
    finally { this.finishing = false; }
  }

  private async reconcile(snapshot: PlaybackSnapshot, sequence: number): Promise<void> {
    if (!this.ownsLease(snapshot)) {
      this.continuation = null; this.continuingAudio.set(false); this.interactionAnchor = null;
      this.player.pause();
      return;
    }
    if (!snapshot.currentTrackRef) {
      this.player.pause();
      return;
    }
    const anchor = playbackAnchor(snapshot);
    if (this.continuation) {
      if (samePlaybackAnchor(this.continuation.anchor, anchor)
        && snapshot.renderPhase === 'awaiting_interaction') return;
      this.continuation = null; this.continuingAudio.set(false);
    }
    if (this.interactionAnchor && (!samePlaybackAnchor(this.interactionAnchor, anchor)
      || snapshot.renderPhase === 'paused'
      || snapshot.renderPhase === 'playing')) {
      this.interactionAnchor = null;
      this.permissionStillBlocked.set(false);
    }
    if (['error','blocked'].includes(snapshot.renderPhase)
      || (this.terminalAnchor && samePlaybackAnchor(this.terminalAnchor,anchor))) {
      this.player.pause(); return;
    }
    const changedTarget = !this.appliedAnchor || !samePlaybackAnchor(this.appliedAnchor,anchor);
    if (changedTarget) {
      this.player.pause();
      this.appliedAnchor = anchor;
      this.loadingAnchor = anchor;
    }
    const startedAt = Date.now();
    const deadline = snapshot.recoveryDeadline ? Date.parse(snapshot.recoveryDeadline) : null;
    let track: Track | null;
    try {
      track = await firstValueFrom(from(this.loadTrack(snapshot.currentTrackRef)).pipe(
        timeout(deadline === null ? 8_000 : Math.max(1, Math.min(8_000, deadline - Date.now()))),
      ));
    } catch {
      track = null;
      this.metadataFailures.set(snapshot.currentTrackRef, { code: 'timeout' });
    }
    if (sequence !== this.reconcileSequence) return;
    this.loadingAnchor = null;
    if (!track) {
      if (snapshot.status !== 'playing') return;
      void this.reportFailure(anchor,{ ...(this.metadataFailureFor(snapshot.currentTrackRef) ?? { code: 'unknown' }), phase: 'metadata',
        positionMs: snapshot.positionMs, elapsedMs: Math.min(120_000,Date.now()-startedAt) });
      return;
    }
    const changedTrack = this.player.track()?.id !== track.id;
    const changedInstance = changedTarget;
    if (changedTrack) this.player.load(track);
    this.player.setRecoveryDeadline(deadline);
    this.appliedAnchor = playbackAnchor(snapshot);
    const expectedSeconds = changedTarget || changedTrack ? snapshot.positionMs/1_000 : estimatedPositionSeconds(snapshot);
    // Starting close to zero should not force a Range restart while metadata is
    // still arriving. Transfers and genuine drift still seek immediately.
    if ((changedInstance && !changedTrack) || (changedTrack && expectedSeconds > 0)
      || (!changedTrack && Math.abs(this.player.positionSeconds() - expectedSeconds) > 2)) {
      this.player.seek(expectedSeconds);
    }
    if (this.pendingEndInstance && this.pendingEndInstance === snapshot.playbackInstanceId) return;
    if (snapshot.renderPhase === 'awaiting_interaction'
      || (this.interactionAnchor && samePlaybackAnchor(this.interactionAnchor, anchor))) {
      this.player.waitForInteraction();
    } else if (snapshot.status === 'playing' && !this.player.requested()) {
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
    endedAnchor?: PlaybackAnchor,
  ): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || this.terminalSocketStop()) return;
    const fixedAnchor = endedAnchor ?? (action === 'seek' || action === 'retry' ? playbackAnchor(snapshot) : undefined);
    await this.issue('control', (revision, commandId, ack, basis) => this.socket.emit('playback:control', {
      commandId,
      expectedRevision: revision,
      action,
      reason,
      anchor: fixedAnchor ?? playbackAnchor(basis),
      ...(positionMs === undefined ? {} : { positionMs }),
    }, ack), fixedAnchor);
  }

  private async publishState(): Promise<void> {
    if (this.publishInFlight) return;
    this.publishInFlight = true;
    try { await this.commands.run(() => this.publishStateNow()); }
    finally { this.publishInFlight = false; }
  }

  private async publishStateNow(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || this.continuation || !this.ownsLease(snapshot) || !this.socket.connected
      || this.terminalAnchor || this.pendingEndInstance || !this.appliedAnchor
      || !samePlaybackAnchor(this.appliedAnchor, playbackAnchor(snapshot))) return;
    // Loading is not evidence of either playback or pause. Wait for actual
    // progress or a terminal recovery failure before changing durable state.
    const waiting = Boolean(this.loadingAnchor) || (this.player.requested() && !this.player.playing()
      && ['loading', 'buffering'].includes(this.player.phase()));
    const permission = snapshot.renderPhase === 'awaiting_interaction'
      || this.player.phase() === 'awaiting_interaction';
    const commandId = crypto.randomUUID();
    const update = {
      commandId,
      expectedRevision: snapshot.revision,
      leaseEpoch: snapshot.leaseEpoch,
      anchor: playbackAnchor(snapshot),
      status: permission ? 'paused' as const : waiting ? snapshot.status : this.player.playing() ? 'playing' as const : 'paused' as const,
      renderPhase: permission ? 'awaiting_interaction' as const : waiting ? 'buffering' as const : this.player.playing() ? 'playing' as const : 'paused' as const,
      positionMs: permission || this.loadingAnchor ? snapshot.positionMs : Math.max(0, Math.round(this.player.positionSeconds() * 1_000)),
    };
    await this.sendCommand('update', commandId,
      (ack) => this.socket.emit('playback:update', update, ack), false);
  }

  private async issue(
    command: PlaybackCommandName,
    emit: (
      revision: number,
      commandId: string,
      ack: (result: PlaybackCommandResult) => void,
      basis: PlaybackSnapshot,
    ) => void,
    targetAnchor?: PlaybackAnchor,
  ): Promise<void> {
    return this.commands.run(async () => {
      const original = this.snapshot();
      if (!original || this.terminalSocketStop()) return;
      if (targetAnchor && !samePlaybackAnchor(targetAnchor, playbackAnchor(original))) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const basis = this.snapshot();
        if (!basis) return;
        const commandId = crypto.randomUUID();
        const result = await this.sendCommand(
          command,
          commandId,
          (ack) => emit(basis.revision, commandId, ack, basis),
          true,
        );
        if (!result || result.error || result.status !== 'conflict') return;
        const current = this.snapshot();
        if (!current || current.sessionId !== original.sessionId
          || !samePlaybackAnchor(playbackAnchor(original), playbackAnchor(current))
          || (!targetAnchor && current.queueRevision !== original.queueRevision)) break;
      }
      this.error.set('El hilo siguió cambiando en otro dispositivo. Inténtalo nuevamente.');
    });
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
          if (command === 'failure' && this.failureResyncs++ < 1) this.retryEndAfterSync = true;
          this.socket.emit('playback:sync', { lastRevision: this.snapshot()?.revision ?? null });
        }
      }
      return null;
    }
    this.receive(result.snapshot);
    if (result.error?.code === 'RETRY_LATER') {
      // The server remains authoritative, including near the deadline or with
      // clock skew. Show a neutral short wait, never an overlapping error toast.
      this.refreshRetryWait(1_000);
    } else if (result.error) {
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
    this.continuation = null; this.continuingAudio.set(false);
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
      if ((this.metadataFailures.get(reference)?.retryAt ?? 0) > Date.now()) continue;
      const existing = this.trackLoads.get(reference);
      if (existing) pending.push(existing);
      else missing.push(reference);
    }
    if (missing.length) {
      const batch = firstValueFrom(this.http.post<ResolveTracksResponse>(
        '/api/music/tracks/resolve', { references: missing },
      ).pipe(timeout(8_000))).then((response) => {
        this.rememberMany(response.tracks);
        const tracks = new Map(response.tracks.map((track) => [track.id, track]));
        for (const failure of response.failures ?? []) {
          this.rememberMetadataFailure(failure.reference, failure);
        }
        if (tracks.size < missing.length) {
          this.error.set(this.error() ?? 'No pudimos recuperar algunas canciones de la cola.');
        }
        return tracks;
      }).catch((error: {status?: number; name?: string}) => {
        for (const reference of missing) this.rememberMetadataFailure(reference, metadataFailure(error));
        this.error.set(this.error() ?? 'No pudimos recuperar algunas canciones de la cola.');
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
    if ((this.metadataFailures.get(reference)?.retryAt ?? 0) > Date.now()) return null;
    const pending = this.trackLoads.get(reference);
    if (pending) return pending;
    const load = firstValueFrom(
      this.http.get<Track>(`/api/music/tracks/${encodeURIComponent(reference)}`).pipe(
        retry({ count: 1, delay: (error: MetadataHttpError) => {
          const failure = metadataFailure(error);
          // The API already exhausted its provider budget. Do not multiply it
          // or restart a provider cooldown with another metadata request.
          if (failure.code === 'service_unavailable' || failure.retryAfterMs !== undefined
            || error.error?.failure) return throwError(() => error);
          return !error.status || [408,425,429].includes(error.status) || error.status >= 500
            ? timer(200 + Math.random() * 100) : throwError(() => error);
        } }),
        timeout(8_000)),
    ).then((track) => {
      this.remember(track);
      return track;
    }).catch((error: {status?: number; name?: string}) => {
      this.rememberMetadataFailure(reference, metadataFailure(error));
      this.error.set(this.error() ?? 'No pudimos recuperar una canción de la cola.');
      return null;
    }).finally(() => this.trackLoads.delete(reference));
    this.trackLoads.set(reference, load);
    return load;
  }

  private remember(track: Track): void {
    this.metadataFailures.delete(track.id);
    this.tracks.set(track.id, track);
    this.queueTracks.set({ ...this.queueTracks(), [track.id]: track });
  }

  private rememberMetadataFailure(reference: string, failure: {code: PlaybackFailureCode; retryAfterMs?: number}): void {
    this.metadataFailures.set(reference, { code: failure.code, retryAfterMs: failure.retryAfterMs,
      ...(failure.retryAfterMs === undefined ? {} : {retryAt: Date.now() + failure.retryAfterMs}) });
  }

  private metadataFailureFor(reference: string): {code: PlaybackFailureCode; retryAfterMs?: number} | undefined {
    const failure = this.metadataFailures.get(reference);
    if (!failure) return undefined;
    return { code: failure.code, ...(failure.retryAt === undefined ? {}
      : { retryAfterMs: Math.max(0, failure.retryAt - Date.now()) }) };
  }

  private rememberMany(tracks: Track[]): void {
    if (!tracks.length) return;
    const additions: Record<string, Track> = {};
    for (const track of tracks) {
      this.metadataFailures.delete(track.id);
      this.tracks.set(track.id, track);
      additions[track.id] = track;
    }
    this.queueTracks.set({ ...this.queueTracks(), ...additions });
  }

  private registerMediaSession(): void {
    this.mediaSession.registerHandlers({
      play: () => void (this.waitingForAudio() ? this.continueAudio()
        : this.unconfirmedFailure() || ['error','blocked'].includes(this.snapshot()?.renderPhase ?? '') ? this.retryCurrent() : this.control('play')),
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

interface MetadataHttpError { status?: number; name?: string; headers?: { get(name: string): string | null };
  error?: { failure?: MusicLookupFailure }; }

function metadataFailure(error: MetadataHttpError): { code: PlaybackFailureCode; retryAfterMs?: number } {
  const provided = error.error?.failure;
  const header = error.headers?.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  const retryAfterMs = provided?.retryAfterMs ?? (header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : undefined);
  const code = error.status === 401 || error.status === 403 ? 'authentication'
    : provided?.code ?? (
    error.status === 503 || error.status === 429 ? 'service_unavailable'
    : error.status === 404 ? 'not_found' : error.name === 'TimeoutError' ? 'timeout' : 'unknown');
  return { code, ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
    ? { retryAfterMs: Math.max(0, Math.min(86_400_000, retryAfterMs)) } : {}) };
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
  if (snapshot.status !== 'playing' || !['unknown','playing'].includes(snapshot.renderPhase ?? 'unknown')) return anchor;
  return anchor + Math.max(0, now - Date.parse(snapshot.positionObservedAt)) / 1_000;
}

export function isTerminalPlaybackDisconnect(reason: string): boolean {
  return reason === 'io server disconnect' || reason === 'io client disconnect';
}
