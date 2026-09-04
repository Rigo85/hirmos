import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import type { Track } from '@hirmos/contracts';

type MediaMetadataFactory = (init: MediaMetadataInit) => MediaMetadata;

export const HIRMOS_MEDIA_SESSION = new InjectionToken<MediaSession | null>(
  'Browser media session',
  {
    providedIn: 'root',
    factory: () => ('mediaSession' in navigator ? navigator.mediaSession : null),
  },
);

export const HIRMOS_MEDIA_METADATA_FACTORY = new InjectionToken<MediaMetadataFactory | null>(
  'Browser media metadata factory',
  {
    providedIn: 'root',
    factory: () => typeof MediaMetadata === 'undefined'
      ? null
      : (init) => new MediaMetadata(init),
  },
);

export interface HirmosMediaSessionHandlers {
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (seconds: number) => void;
}

export interface HirmosMediaSessionState {
  active: boolean;
  track: Track | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

@Injectable({ providedIn: 'root' })
export class MediaSessionService {
  private readonly mediaSession = inject(HIRMOS_MEDIA_SESSION);
  private readonly metadataFactory = inject(HIRMOS_MEDIA_METADATA_FACTORY);
  private readonly document = inject(DOCUMENT);
  private metadataKey: string | null = null;
  private published = false;

  public registerHandlers(handlers: HirmosMediaSessionHandlers): void {
    this.setActionHandler('play', handlers.play);
    this.setActionHandler('pause', handlers.pause);
    this.setActionHandler('nexttrack', handlers.next);
    this.setActionHandler('previoustrack', handlers.previous);
    this.setActionHandler('seekto', (details) => {
      if (isFiniteNumber(details.seekTime)) handlers.seekTo(details.seekTime);
    });
    this.setActionHandler('seekbackward', (details) => {
      handlers.seekBy(-seekOffset(details.seekOffset));
    });
    this.setActionHandler('seekforward', (details) => {
      handlers.seekBy(seekOffset(details.seekOffset));
    });
  }

  public synchronize(state: HirmosMediaSessionState): void {
    if (!state.active || !state.track) {
      this.clear();
      return;
    }
    this.publishMetadata(state.track);
    if (!this.mediaSession) return;
    this.published = true;
    try {
      this.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch { /* A partial implementation must not affect playback. */ }
    this.publishPosition(state.positionSeconds, state.durationSeconds);
  }

  public clear(): void {
    if (!this.mediaSession || !this.published) return;
    try { this.mediaSession.metadata = null; } catch { /* unsupported by this browser */ }
    try { this.mediaSession.playbackState = 'none'; } catch { /* unsupported by this browser */ }
    try { this.mediaSession.setPositionState(); } catch { /* unsupported by this browser */ }
    this.metadataKey = null;
    this.published = false;
  }

  private publishMetadata(track: Track): void {
    if (!this.mediaSession || !this.metadataFactory) return;
    const key = [track.id, track.title, track.artist, track.album, track.coverUrl ?? ''].join('\u0000');
    if (key === this.metadataKey) return;
    try {
      this.mediaSession.metadata = this.metadataFactory({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: this.artwork(track),
      });
      this.metadataKey = key;
      this.published = true;
    } catch { /* invalid artwork or an incomplete platform implementation */ }
  }

  private publishPosition(positionSeconds: number, durationSeconds: number): void {
    if (!this.mediaSession || typeof this.mediaSession.setPositionState !== 'function') return;
    if (!isFiniteNumber(durationSeconds) || durationSeconds <= 0) {
      try { this.mediaSession.setPositionState(); } catch { /* unsupported by this browser */ }
      return;
    }
    const position = isFiniteNumber(positionSeconds)
      ? Math.min(durationSeconds, Math.max(0, positionSeconds))
      : 0;
    try {
      this.mediaSession.setPositionState({ duration: durationSeconds, playbackRate: 1, position });
    } catch { /* invalid or unsupported position state must not affect audio */ }
  }

  private artwork(track: Track): MediaImage[] {
    if (track.coverUrl) {
      try {
        return [{ src: new URL(track.coverUrl, this.document.baseURI).href }];
      } catch { /* fall through to the application artwork */ }
    }
    return [
      {
        src: new URL('/icons/hirmos-192.png', this.document.baseURI).href,
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: new URL('/icons/hirmos-512.png', this.document.baseURI).href,
        sizes: '512x512',
        type: 'image/png',
      },
    ];
  }

  private setActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler,
  ): void {
    if (!this.mediaSession) return;
    try { this.mediaSession.setActionHandler(action, handler); } catch {
      // Browsers expose different subsets of actions. Register what is available.
    }
  }
}

function seekOffset(value: number | undefined): number {
  return isFiniteNumber(value) && value > 0 ? value : 10;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
