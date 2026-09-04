import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import {
  AUDIO_PROGRESS_TIMEOUT_MS,
  AudioPlayerService,
  HIRMOS_AUDIO_ELEMENT,
} from './audio-player.service';

describe('AudioPlayerService', () => {
  let audio: FakeAudio;
  let service: AudioPlayerService;

  beforeEach(() => {
    vi.useFakeTimers();
    audio = new FakeAudio();
    TestBed.configureTestingModule({
      providers: [
        AudioPlayerService,
        { provide: HIRMOS_AUDIO_ELEMENT, useValue: audio as unknown as HTMLAudioElement },
        { provide: AUDIO_PROGRESS_TIMEOUT_MS, useValue: 100 },
      ],
    });
    service = TestBed.inject(AudioPlayerService);
  });

  afterEach(() => {
    service.pause();
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('does not claim playback until currentTime advances and retries a stalled source', async () => {
    const started = vi.fn();
    service.onPlaybackStarted(started);
    service.load(track);
    await service.resume();

    expect(service.requested()).toBe(true);
    expect(service.playing()).toBe(false);
    expect(service.phase()).toBe('buffering');

    await vi.advanceTimersByTimeAsync(101);
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.src).toContain('?attempt=1');
    expect(service.playing()).toBe(false);

    audio.readyState = 4;
    audio.currentTime = 1;
    audio.paused = false;
    audio.dispatchEvent(new Event('timeupdate'));

    expect(service.playing()).toBe(true);
    expect(service.phase()).toBe('playing');
    expect(service.positionSeconds()).toBe(1);
    expect(started).toHaveBeenCalledOnce();
  });

  it('stops reporting playback and exposes an error after bounded retries', async () => {
    const failed = vi.fn();
    service.onPlaybackFailed(failed);
    service.load(track);
    await service.resume();

    await vi.advanceTimersByTimeAsync(303);

    expect(audio.load).toHaveBeenCalledTimes(3);
    expect(service.requested()).toBe(false);
    expect(service.playing()).toBe(false);
    expect(service.phase()).toBe('error');
    expect(service.error()).toContain('no avanzó');
    expect(failed).toHaveBeenCalledOnce();
  });

  it('cancels recovery when playback is paused deliberately', async () => {
    service.load(track);
    await service.resume();
    service.pause();
    await vi.advanceTimersByTimeAsync(500);

    expect(audio.load).toHaveBeenCalledOnce();
    expect(service.phase()).toBe('paused');
    expect(service.requested()).toBe(false);
  });

  it('accumulates frequent sub-threshold time updates as real progress', async () => {
    service.load(track);
    await service.resume();

    for (let elapsed = 0; elapsed < 300; elapsed += 20) {
      await vi.advanceTimersByTimeAsync(20);
      audio.currentTime += 0.02;
      audio.paused = false;
      audio.dispatchEvent(new Event('timeupdate'));
    }

    expect(service.playing()).toBe(true);
    expect(service.phase()).toBe('playing');
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it('restores the consecutive retry budget after stable playback', async () => {
    service.load(track);
    await service.resume();
    await vi.advanceTimersByTimeAsync(101);

    for (let elapsed = 0; elapsed < 3_100; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      audio.currentTime += 0.1;
      audio.paused = false;
      audio.dispatchEvent(new Event('timeupdate'));
    }

    await vi.advanceTimersByTimeAsync(101);
    await vi.advanceTimersByTimeAsync(101);

    expect(service.requested()).toBe(true);
    expect(service.phase()).toBe('buffering');
    expect(audio.load).toHaveBeenCalledTimes(4);
  });

  it('ignores a stale play rejection after recovery replaces the source', async () => {
    let rejectFirstPlay!: (reason?: unknown) => void;
    const firstPlay = new Promise<void>((_resolve, reject) => {
      rejectFirstPlay = reject;
    });
    audio.play.mockImplementationOnce(() => firstPlay);
    service.load(track);
    const initialResume = service.resume();

    audio.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    rejectFirstPlay(new DOMException('Replaced source', 'AbortError'));
    await initialResume;

    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(service.requested()).toBe(true);
    expect(service.phase()).not.toBe('error');
  });

  it('does not publish a failure for a stale error while preloading', () => {
    const failed = vi.fn();
    service.onPlaybackFailed(failed);
    service.load(track);
    audio.dispatchEvent(new Event('error'));

    expect(service.phase()).toBe('loading');
    expect(service.error()).toBeNull();
    expect(failed).not.toHaveBeenCalled();
  });

  it('keeps the next track active when the previous play promise rejects late', async () => {
    let rejectPreviousPlay!: (reason?: unknown) => void;
    const previousPlay = new Promise<void>((_resolve, reject) => {
      rejectPreviousPlay = reject;
    });
    audio.play.mockImplementationOnce(() => previousPlay);
    service.load(track);
    const previousResume = service.resume();

    const nextTrack = { ...track, id: 'next-track', title: 'Siguiente' };
    service.load(nextTrack);
    await service.resume();
    rejectPreviousPlay(new DOMException('Replaced source', 'AbortError'));
    await previousResume;

    expect(service.track()).toEqual(nextTrack);
    expect(service.requested()).toBe(true);
    expect(service.phase()).toBe('buffering');
    expect(service.error()).toBeNull();
  });
});

class FakeAudio extends EventTarget {
  preload = '';
  volume = 1;
  src = '';
  currentTime = 0;
  duration = 180;
  readyState = 0;
  networkState = 1;
  paused = true;

  readonly load = vi.fn(() => {
    this.readyState = 0;
    this.dispatchEvent(new Event('loadstart'));
  });

  readonly play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  });

  readonly pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
}

const track: Track = {
  id: 'encoded-track',
  title: 'Canción',
  artist: 'Artista',
  artistId: 'artist',
  album: 'Álbum',
  albumId: 'album',
  durationMs: 180_000,
  coverUrl: null,
  year: 2026,
  favorite: false,
};
