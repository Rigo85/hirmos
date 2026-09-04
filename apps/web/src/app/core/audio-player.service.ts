import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { Track } from '@hirmos/contracts';

export type AudioPlaybackPhase =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
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

@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  private readonly audio = inject(HIRMOS_AUDIO_ELEMENT);
  private readonly progressTimeoutMs = inject(AUDIO_PROGRESS_TIMEOUT_MS);
  readonly track = signal<Track | null>(null);
  readonly playing = signal(false);
  readonly requested = signal(false);
  readonly phase = signal<AudioPlaybackPhase>('idle');
  readonly positionSeconds = signal(0);
  readonly durationSeconds = signal(0);
  readonly error = signal<string | null>(null);
  readonly volume = signal(0.8);
  private endedHandler: (() => void) | null = null;
  private playbackStartedHandler: (() => void) | null = null;
  private playbackFailedHandler: ((message: string) => void) | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private lastObservedPosition = 0;
  private recoveryAttempts = 0;
  private totalRecoveryAttempts = 0;
  private lastRecoveryAt = 0;
  private sourceAttempt = 0;
  private sourceGeneration = 0;
  private pendingSeek: number | null = null;
  private recoveryInFlight = false;

  public constructor() {
    this.audio.preload = 'metadata';
    this.audio.volume = this.volume();
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
      if (!this.requested() && this.phase() !== 'error') this.phase.set('paused');
    });
    this.audio.addEventListener('ended', () => {
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
      if (this.requested()) void this.recoverOrFail();
    });
  }

  public load(track: Track): void {
    this.error.set(null);
    if (this.track()?.id === track.id) return;
    this.requested.set(false);
    this.clearWatchdog();
    this.audio.pause();
    this.track.set(track);
    this.playing.set(false);
    this.phase.set('loading');
    this.positionSeconds.set(0);
    this.durationSeconds.set(track.durationMs / 1_000);
    this.lastObservedPosition = 0;
    this.recoveryAttempts = 0;
    this.totalRecoveryAttempts = 0;
    this.lastRecoveryAt = 0;
    this.sourceAttempt = 0;
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
    this.requested.set(false);
    this.clearWatchdog();
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
    const volume = Math.min(1, Math.max(0, value));
    this.audio.volume = volume;
    this.volume.set(volume);
  }

  public onEnded(handler: () => void): void {
    this.endedHandler = handler;
  }

  public onPlaybackStarted(handler: () => void): void {
    this.playbackStartedHandler = handler;
  }

  public onPlaybackFailed(handler: (message: string) => void): void {
    this.playbackFailedHandler = handler;
  }

  public async resume(): Promise<void> {
    if (!this.track() || this.requested()) return;
    this.error.set(null);
    this.requested.set(true);
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
    try {
      await this.audio.play();
    } catch (error) {
      // Loading a replacement source rejects the previous play() promise with
      // AbortError. That stale rejection must not stop the newer attempt.
      if (!this.requested() || generation !== this.sourceGeneration) return;
      this.fail(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'El navegador no permitió iniciar la reproducción. Inténtalo nuevamente.'
        : 'No pudimos iniciar esta canción. Inténtalo nuevamente.');
    }
  }

  private observeProgress(): void {
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
    if (this.recoveryAttempts > 0
      && this.lastProgressAt - this.lastRecoveryAt >= STABLE_PLAYBACK_RESET_MS) {
      this.recoveryAttempts = 0;
    }
    const firstProgress = !this.playing();
    this.playing.set(true);
    this.phase.set('playing');
    if (firstProgress) this.playbackStartedHandler?.();
  }

  private markBuffering(): void {
    if (!this.requested()) return;
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
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.requested()) return;
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
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS
      || this.totalRecoveryAttempts >= MAX_TOTAL_RECOVERY_ATTEMPTS) {
      this.fail('La reproducción se detuvo porque el audio no avanzó. Puedes intentarlo nuevamente.');
      return;
    }
    this.recoveryInFlight = true;
    this.recoveryAttempts += 1;
    this.totalRecoveryAttempts += 1;
    this.lastRecoveryAt = Date.now();
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
    this.pendingSeek = seekTo === undefined ? null : Math.max(0, seekTo);
    const base = `/api/music/tracks/${encodeURIComponent(track.id)}/stream`;
    this.audio.src = this.sourceAttempt ? `${base}?attempt=${this.sourceAttempt}` : base;
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

  private fail(message: string): void {
    this.requested.set(false);
    this.playing.set(false);
    this.phase.set('error');
    this.error.set(message);
    this.clearWatchdog();
    this.audio.pause();
    this.playbackFailedHandler?.(message);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
