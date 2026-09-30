import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { Track, PlaybackFailure, PlaybackFailureCode } from '@hirmos/contracts';

export type AudioPlaybackPhase =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'awaiting_interaction'
  | 'error';

export const HIRMOS_AUDIO_ELEMENT = new InjectionToken<HTMLAudioElement>(
  'Hirmos audio element',
  { providedIn: 'root', factory: () => new Audio() },
);

export const AUDIO_PROGRESS_TIMEOUT_MS = new InjectionToken<number>(
  'Audio progress timeout',
  { providedIn: 'root', factory: () => 8_000 },
);

const MAX_RECOVERY_ATTEMPTS = 2;
const MAX_TOTAL_RECOVERY_ATTEMPTS = 6;
const MINIMUM_PROGRESS_SECONDS = 0.05;
const STABLE_PLAYBACK_RESET_MS = 3_000;
export const AUDIO_OUTPUT_STORAGE_KEY = 'hirmos.audio-output.v1';
export const AUDIO_OUTPUT_STORAGE = new InjectionToken<Pick<Storage, 'getItem' | 'setItem'> | null>(
  'Local audio output preferences',
  { providedIn: 'root', factory: () => {
    try { return window.localStorage; } catch { return null; }
  } },
);
interface AudioOutputPreference { volume: number; muted: boolean }
const DEFAULT_AUDIO_OUTPUT: AudioOutputPreference = { volume: 0.8, muted: false };

@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  private readonly audio = inject(HIRMOS_AUDIO_ELEMENT);
  private readonly progressTimeoutMs = inject(AUDIO_PROGRESS_TIMEOUT_MS);
  private readonly outputStorage = inject(AUDIO_OUTPUT_STORAGE);
  private readonly initialOutput = this.readOutputPreference(DEFAULT_AUDIO_OUTPUT);
  readonly track = signal<Track | null>(null);
  readonly playing = signal(false);
  readonly requested = signal(false);
  readonly phase = signal<AudioPlaybackPhase>('idle');
  readonly positionSeconds = signal(0);
  readonly durationSeconds = signal(0);
  readonly error = signal<string | null>(null);
  readonly volume = signal(this.initialOutput.volume);
  readonly muted = signal(this.initialOutput.muted);
  private endedHandler: (() => void) | null = null;
  private playbackStartedHandler: (() => void) | null = null;
  private interactionRequiredHandler: (() => void) | null = null;
  private playbackFailedHandler: ((message: string, failure: PlaybackFailure & { requestId: string | null }) => void) | null = null;
  private requestId: string | null = null;
  private episodeStartedAt = 0;
  private stableSince = 0;
  private recoveryDeadline: number | null = null;
  private observedDeadline: number | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private lastObservedPosition = 0;
  private recoveryAttempts = 0;
  private totalRecoveryAttempts = 0;
  private sourceAttempt = 0;
  private sourceGeneration = 0;
  private playGeneration = 0;
  private pendingSeek: number | null = null;
  private recoveryInFlight = false;
  private recoveryCheck: ((requestId: string) => Promise<Pick<PlaybackFailure, 'code' | 'retryAfterMs'> | null>) | null = null;

  public constructor() {
    this.audio.preload = 'metadata';
    this.audio.volume = this.volume();
    this.audio.muted = this.muted();
    // Local output only: never part of the shared playback snapshot/lease.
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== null && event.key !== AUDIO_OUTPUT_STORAGE_KEY) return;
      const preference = this.readOutputPreference({ volume: this.volume(), muted: this.muted() });
      this.volume.set(preference.volume);
      this.muted.set(preference.muted);
      this.applyOutputPreference();
    };
    window.addEventListener('storage', storageChanged);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', storageChanged));
    this.audio.addEventListener('loadstart', () => {
      if (this.requested()) this.phase.set('loading');
    });
    this.audio.addEventListener('loadedmetadata', () => {
      this.durationSeconds.set(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
      this.applyPendingSeek();
    });
    this.audio.addEventListener('playing', () => {
      if (!this.requested()) return;
      // Browser acceptance is not playback evidence. Only currentTime
      // advancing makes this device authoritative.
      this.phase.set('buffering');
      this.armWatchdog();
    });
    this.audio.addEventListener('waiting', () => this.markBuffering());
    this.audio.addEventListener('stalled', () => this.markBuffering());
    this.audio.addEventListener('pause', () => {
      this.playing.set(false);
      if (!this.requested() && !['error', 'awaiting_interaction'].includes(this.phase())) this.phase.set('paused');
    });
    this.audio.addEventListener('ended', () => {
      // A queued DOM event may belong to the source that has just been replaced.
      if (!this.audio.ended || !this.requested()) return;
      this.positionSeconds.set(this.audio.currentTime);
      this.requested.set(false);
      this.playing.set(false);
      this.phase.set('paused');
      this.clearWatchdog();
      this.endedHandler?.();
    });
    this.audio.addEventListener('timeupdate', () => this.observeProgress());
    this.audio.addEventListener('durationchange', () => {
      this.durationSeconds.set(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    });
    this.audio.addEventListener('error', () => {
      if (!this.requested()) return;
      const code = this.audio.error?.code;
      if (code === 3 || code === 4) this.fail('No pudimos reproducir este audio.', code === 3 ? 'decode' : 'unsupported');
      else if (code !== 1) void this.recoverOrFail();
    });
  }

  public load(track: Track): void {
    this.error.set(null);
    if (this.track()?.id === track.id) return;
    this.requested.set(false);
    this.playGeneration += 1;
    this.clearWatchdog();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryInFlight = false;
    this.audio.pause();
    this.track.set(track);
    this.playing.set(false);
    this.phase.set('loading');
    this.positionSeconds.set(0);
    this.durationSeconds.set(track.durationMs / 1_000);
    this.lastObservedPosition = 0;
    this.recoveryAttempts = 0;
    this.totalRecoveryAttempts = 0;
    this.recoveryDeadline = null;
    this.observedDeadline = null;
    this.sourceAttempt = 0;
    this.episodeStartedAt = Date.now();
    this.stableSince = 0;
    this.pendingSeek = null;
    this.assignSource();
  }

  public async play(track: Track): Promise<void> {
    this.load(track);
    await this.resume();
  }

  public async toggle(): Promise<void> {
    if (this.requested()) this.pause();
    else await this.resume();
  }

  public pause(): void {
    this.playGeneration += 1;
    this.requested.set(false);
    this.clearWatchdog();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryInFlight = false;
    this.audio.pause();
    this.playing.set(false);
    if (this.phase() !== 'error') this.phase.set('paused');
  }

  public seek(seconds: number): void {
    const position = Math.max(0, seconds);
    this.positionSeconds.set(position);
    this.lastObservedPosition = position;
    if (this.audio.readyState > 0) {
      this.audio.currentTime = Math.min(position, this.audio.duration || position);
      this.pendingSeek = null;
      return;
    }
    this.pendingSeek = position;
  }

  public setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    const volume = Math.min(1, Math.max(0, value));
    this.volume.set(volume);
    // Moving the slider is an explicit request for audible output (or zero).
    this.muted.set(false);
    this.applyOutputPreference();
    this.saveOutputPreference();
  }

  public toggleMuted(): void {
    this.muted.update(value => !value);
    this.applyOutputPreference();
    this.saveOutputPreference();
  }

  private applyOutputPreference(): void {
    this.audio.volume = this.volume();
    this.audio.muted = this.muted();
  }

  private readOutputPreference(fallback: AudioOutputPreference): AudioOutputPreference {
    try {
      const raw = this.outputStorage?.getItem(AUDIO_OUTPUT_STORAGE_KEY);
      if (!raw) return fallback;
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && 'volume' in value && 'muted' in value
        && typeof value.volume === 'number' && Number.isFinite(value.volume)
        && value.volume >= 0 && value.volume <= 1 && typeof value.muted === 'boolean') {
        return { volume: value.volume, muted: value.muted };
      }
    } catch { /* Blocked/corrupt storage must not prevent playback. */ }
    return fallback;
  }

  private saveOutputPreference(): void {
    try {
      this.outputStorage?.setItem(AUDIO_OUTPUT_STORAGE_KEY,
        JSON.stringify({ volume: this.volume(), muted: this.muted() }));
    } catch { /* This session still works when storage is unavailable/full. */ }
  }

  public setRecoveryDeadline(deadline: number | null): void {
    // A repeated heartbeat must not restore a budget already cleared by
    // sustained local playback while the server awaits its next progress report.
    if (deadline === this.observedDeadline) return;
    this.observedDeadline = deadline;
    this.recoveryDeadline = deadline;
    if (this.requested()) this.armWatchdog();
  }

  public onEnded(handler: () => void): void {
    this.endedHandler = handler;
  }

  public onPlaybackStarted(handler: () => void): void {
    this.playbackStartedHandler = handler;
  }

  public onInteractionRequired(handler: () => void): void {
    this.interactionRequiredHandler = handler;
  }

  public waitForInteraction(): void {
    this.pause();
    this.error.set(null);
    this.phase.set('awaiting_interaction');
  }

  public onPlaybackFailed(handler: (message: string, failure: PlaybackFailure & { requestId: string | null }) => void): void {
    this.playbackFailedHandler = handler;
  }

  public onRecoveryCheck(handler: NonNullable<AudioPlayerService['recoveryCheck']>): void {
    this.recoveryCheck = handler;
  }

  public async resume(): Promise<void> {
    if (!this.track() || this.requested()) return;
    this.error.set(null);
    this.requested.set(true);
    this.episodeStartedAt = Date.now();
    this.stableSince = 0;
    this.playing.set(false);
    if (this.phase() === 'error' || this.audio.networkState === 3) {
      this.recoveryAttempts = 0;
      this.totalRecoveryAttempts = 0;
      this.sourceAttempt += 1;
      this.assignSource(this.positionSeconds());
    }
    this.phase.set(this.audio.readyState > 2 ? 'buffering' : 'loading');
    this.beginProgressWindow();
    await this.tryPlay();
  }

  private async tryPlay(): Promise<void> {
    const generation = this.sourceGeneration;
    const playGeneration = ++this.playGeneration;
    try {
      await this.audio.play();
    } catch (error) {
      // Loading a replacement source rejects the previous play() promise with
      // AbortError. That stale rejection must not stop the newer attempt.
      if (!this.requested() || generation !== this.sourceGeneration || playGeneration !== this.playGeneration) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.waitForInteraction();
        this.interactionRequiredHandler?.();
        return;
      }
      this.fail('No pudimos iniciar esta canción. Inténtalo nuevamente.',
        error instanceof DOMException && error.name === 'NotSupportedError' ? 'unsupported' : 'unknown');
    }
  }

  private observeProgress(): void {
    // Replacing src can emit timeupdate at zero before metadata restores the
    // pending seek. That reset is not the listener's last heard position.
    if (this.pendingSeek !== null && this.audio.readyState === 0) return;
    const position = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    this.positionSeconds.set(position);
    const advanced = position > this.lastObservedPosition + MINIMUM_PROGRESS_SECONDS;
    if (!this.requested() || this.audio.paused) {
      this.lastObservedPosition = position;
      return;
    }
    // timeupdate may fire more often than the minimum delta. Keep the last
    // meaningful position so several small increments count as real progress.
    if (!advanced) return;
    this.lastObservedPosition = position;
    this.lastProgressAt = Date.now();
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.recoveryInFlight = false;
      this.armWatchdog();
    }
    this.stableSince ||= this.lastProgressAt;
    if (this.lastProgressAt - this.stableSince >= STABLE_PLAYBACK_RESET_MS) {
      this.recoveryAttempts = 0;
      this.episodeStartedAt = 0;
      this.recoveryDeadline = null;
    }
    const firstProgress = !this.playing();
    this.playing.set(true);
    this.phase.set('playing');
    if (firstProgress) this.playbackStartedHandler?.();
  }

  private markBuffering(): void {
    if (!this.requested()) return;
    this.stableSince = 0;
    this.playing.set(false);
    this.phase.set('buffering');
    this.armWatchdog();
  }

  private beginProgressWindow(): void {
    this.lastProgressAt = Date.now();
    this.lastObservedPosition = this.positionSeconds();
    this.armWatchdog();
  }

  private armWatchdog(delay = this.progressTimeoutMs): void {
    this.clearWatchdog();
    if (!this.playing() && this.recoveryDeadline !== null) {
      delay = Math.min(delay, this.recoveryDeadline - Date.now());
    }
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.requested()) return;
      if (!this.playing() && this.recoveryDeadline !== null && Date.now() >= this.recoveryDeadline) {
        this.fail('El audio no avanzó dentro del presupuesto de recuperación.', 'timeout');
        return;
      }
      const idleMs = Date.now() - this.lastProgressAt;
      if (idleMs < this.progressTimeoutMs) {
        this.armWatchdog(this.progressTimeoutMs - idleMs);
        return;
      }
      void this.recoverOrFail();
    }, Math.max(1, delay));
  }

  private async recoverOrFail(): Promise<void> {
    if (!this.requested() || this.recoveryInFlight) return;
    if (!this.episodeStartedAt) this.episodeStartedAt = this.lastProgressAt;
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS
      || this.totalRecoveryAttempts >= MAX_TOTAL_RECOVERY_ATTEMPTS
      || (this.recoveryDeadline !== null && Date.now() >= this.recoveryDeadline)
      || Date.now() - this.episodeStartedAt >= 24_000) {
      this.fail('El audio no avanzó después de intentar recuperarlo.', 'timeout');
      return;
    }
    this.recoveryInFlight = true;
    const generation = this.sourceGeneration;
    const playGeneration = this.playGeneration;
    const observedAt = this.lastProgressAt;
    const observedPosition = this.lastObservedPosition;
    if (this.recoveryCheck && this.requestId) {
      const hint = await this.recoveryCheck(this.requestId).catch(() => null);
      if (!this.requested() || generation !== this.sourceGeneration || playGeneration !== this.playGeneration) return;
      if ((this.lastProgressAt > observedAt || this.lastObservedPosition > observedPosition) && this.playing()) {
        this.recoveryInFlight = false;
        this.armWatchdog();
        return;
      }
      if (hint && (['service_unavailable', 'authentication', 'offline', 'not_found'].includes(hint.code)
        || (hint.retryAfterMs ?? 0) > 0)) {
        this.fail('No pudimos recuperar el servicio de audio.', hint.code === 'unknown' ? 'service_unavailable' : hint.code, hint.retryAfterMs);
        return;
      }
    }
    const delay = Math.min(200, this.progressTimeoutMs / 10) * 2 ** this.recoveryAttempts;
    const remaining = this.recoveryDeadline === null ? Infinity : this.recoveryDeadline - Date.now();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.requested() || generation !== this.sourceGeneration) { this.recoveryInFlight = false; return; }
      if (Date.now() - this.lastProgressAt < this.progressTimeoutMs && this.playing()) {
        this.recoveryInFlight = false;
        this.armWatchdog();
        return;
      }
      if (this.recoveryDeadline !== null && Date.now() >= this.recoveryDeadline) {
        this.fail('El audio no avanzó dentro del presupuesto de recuperación.', 'timeout');
        return;
      }
      void this.recoverSource();
    }, Math.min(remaining, delay + Math.random() * delay * 0.25));
  }

  private async recoverSource(): Promise<void> {
    this.stableSince = 0;
    this.recoveryAttempts += 1;
    this.totalRecoveryAttempts += 1;
    this.sourceAttempt += 1;
    const target = this.positionSeconds();
    this.playing.set(false);
    this.phase.set('loading');
    this.audio.pause();
    this.assignSource(target);
    this.beginProgressWindow();
    this.recoveryInFlight = false;
    await this.tryPlay();
  }

  private assignSource(seekTo?: number): void {
    const track = this.track();
    if (!track) return;
    this.sourceGeneration += 1;
    this.requestId = crypto.randomUUID();
    this.pendingSeek = seekTo === undefined ? null : Math.max(0, seekTo);
    const base = `/api/music/tracks/${encodeURIComponent(track.id)}/stream`;
    this.audio.src = `${base}?attempt=${this.sourceAttempt}&playbackRequest=${this.requestId}`;
    this.audio.load();
  }

  private applyPendingSeek(): void {
    if (this.pendingSeek === null) return;
    const position = Math.min(this.pendingSeek, this.audio.duration || this.pendingSeek);
    this.pendingSeek = null;
    this.audio.currentTime = position;
    this.positionSeconds.set(position);
    this.lastObservedPosition = position;
  }

  private fail(message: string, code: PlaybackFailureCode = 'unknown', retryAfterMs?: number): void {
    const phase = this.positionSeconds() > 0 ? 'stream' : 'start';
    this.requested.set(false);
    this.playing.set(false);
    this.phase.set('error');
    this.error.set(message);
    this.clearWatchdog();
    this.audio.pause();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryInFlight = false;
    this.playbackFailedHandler?.(message, { code, phase,
      positionMs: Math.round(this.positionSeconds() * 1_000),
      elapsedMs: Math.min(120_000, Math.max(0, Date.now() - (this.episodeStartedAt || Date.now()))),
      requestId: this.requestId, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
