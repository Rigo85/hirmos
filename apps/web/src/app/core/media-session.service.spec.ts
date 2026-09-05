import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import {
  HIRMOS_MEDIA_METADATA_FACTORY,
  HIRMOS_MEDIA_SESSION,
  MediaSessionService,
} from './media-session.service';

describe('MediaSessionService', () => {
  let browser: FakeMediaSession;
  let service: MediaSessionService;

  beforeEach(() => {
    browser = new FakeMediaSession();
    TestBed.configureTestingModule({
      providers: [
        MediaSessionService,
        { provide: HIRMOS_MEDIA_SESSION, useValue: browser as unknown as MediaSession },
        { provide: HIRMOS_MEDIA_METADATA_FACTORY, useValue: (init: MediaMetadataInit) => init },
        { provide: DOCUMENT, useValue: { baseURI: 'https://hirmos.example/' } },
      ],
    });
    service = TestBed.inject(MediaSessionService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('publishes the active track, authenticated artwork, playback state and position', () => {
    service.synchronize({
      active: true,
      track,
      playing: true,
      positionSeconds: 42,
      durationSeconds: 180,
    });

    expect(browser.metadata).toEqual({
      title: 'Canción',
      artist: 'Artista',
      album: 'Álbum',
      artwork: [{ src: 'https://hirmos.example/api/music/covers/cover-id' }],
    });
    expect(browser.playbackState).toBe('playing');
    expect(browser.setPositionState).toHaveBeenLastCalledWith({
      duration: 180,
      playbackRate: 1,
      position: 42,
    });
  });

  it('uses the Hirmos artwork as fallback and clamps invalid positions', () => {
    service.synchronize({
      active: true,
      track: { ...track, coverUrl: null },
      playing: false,
      positionSeconds: 300,
      durationSeconds: 180,
    });

    expect(browser.metadata).toMatchObject({
      artwork: [
        { src: 'https://hirmos.example/icons/hirmos-192.png', sizes: '192x192' },
        { src: 'https://hirmos.example/icons/hirmos-512.png', sizes: '512x512' },
      ],
    });
    expect(browser.playbackState).toBe('paused');
    expect(browser.setPositionState).toHaveBeenLastCalledWith(expect.objectContaining({
      position: 180,
    }));
  });

  it('clears stale system metadata when this device is no longer active', () => {
    service.synchronize({
      active: true, track, playing: true, positionSeconds: 1, durationSeconds: 180,
    });
    service.synchronize({
      active: false, track, playing: false, positionSeconds: 1, durationSeconds: 180,
    });

    expect(browser.metadata).toBeNull();
    expect(browser.playbackState).toBe('none');
    expect(browser.setPositionState).toHaveBeenLastCalledWith();
  });

  it('maps the available operating-system actions to Hirmos controls', () => {
    const handlers = {
      play: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(),
      seekTo: vi.fn(), seekBy: vi.fn(),
    };
    service.registerHandlers(handlers);

    browser.actions.get('play')?.({ action: 'play' });
    browser.actions.get('pause')?.({ action: 'pause' });
    browser.actions.get('nexttrack')?.({ action: 'nexttrack' });
    browser.actions.get('previoustrack')?.({ action: 'previoustrack' });
    browser.actions.get('seekto')?.({ action: 'seekto', seekTime: 25 });
    browser.actions.get('seekbackward')?.({ action: 'seekbackward' });
    browser.actions.get('seekforward')?.({ action: 'seekforward', seekOffset: 30 });

    expect(handlers.play).toHaveBeenCalledOnce();
    expect(handlers.pause).toHaveBeenCalledOnce();
    expect(handlers.next).toHaveBeenCalledOnce();
    expect(handlers.previous).toHaveBeenCalledOnce();
    expect(handlers.seekTo).toHaveBeenCalledWith(25);
    expect(handlers.seekBy).toHaveBeenNthCalledWith(1, -10);
    expect(handlers.seekBy).toHaveBeenNthCalledWith(2, 30);
  });
});

class FakeMediaSession {
  metadata: MediaMetadataInit | null = null;
  playbackState: MediaSessionPlaybackState = 'none';
  readonly actions = new Map<MediaSessionAction, MediaSessionActionHandler>();
  readonly setPositionState = vi.fn((_state?: MediaPositionState) => undefined);

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (handler) this.actions.set(action, handler);
    else this.actions.delete(action);
  }
}

const track: Track = {
  id: 'track-id',
  title: 'Canción',
  artist: 'Artista',
  artistId: 'artist-id',
  album: 'Álbum',
  albumId: 'album-id',
  durationMs: 180_000,
  coverUrl: '/api/music/covers/cover-id',
  year: 2026,
  genres: [],
  favorite: false,
};
