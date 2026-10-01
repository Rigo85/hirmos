import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import {
  AUDIO_PROGRESS_TIMEOUT_MS,
  AudioPlayerService,
  HIRMOS_AUDIO_ELEMENT,
  AUDIO_OUTPUT_STORAGE,
  AUDIO_OUTPUT_STORAGE_KEY,
} from './audio-player.service';

describe('AudioPlayerService', () => {
  let audio: FakeAudio;
  let service: AudioPlayerService;
  let saved: string | null;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = null;
    storage = {
      getItem: vi.fn(() => saved),
      setItem: vi.fn((_key: string, value: string) => { saved = value; }),
    };
    audio = new FakeAudio();
    TestBed.configureTestingModule({
      providers: [
        AudioPlayerService,
        { provide: AUDIO_OUTPUT_STORAGE, useValue: storage },
        { provide: HIRMOS_AUDIO_ELEMENT, useValue: audio as unknown as HTMLAudioElement },
        { provide: AUDIO_PROGRESS_TIMEOUT_MS, useValue: 100 },
      ],
    });
    service = TestBed.inject(AudioPlayerService);
  });

  function reloadPlayer(): void {
    service.pause();
    TestBed.resetTestingModule();
    audio = new FakeAudio();
    TestBed.configureTestingModule({ providers: [AudioPlayerService,
      { provide: HIRMOS_AUDIO_ELEMENT, useValue: audio },
      { provide: AUDIO_OUTPUT_STORAGE, useValue: storage },
      { provide: AUDIO_PROGRESS_TIMEOUT_MS, useValue: 100 },
    ] });
    service = TestBed.inject(AudioPlayerService);
  }

  it('starts at eighty percent only without a saved preference', () => {
    expect(audio.volume).toBe(0.8);
    expect(audio.muted).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('clears removed audio and ignores late DOM events while preserving local volume', async () => {
    await service.play(track);
    service.setVolume(0.35); service.toggleMuted();
    service.seek(46);
    service.clear();
    expect(audio.src).toBe('');
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    audio.currentTime = 46;
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'pause', 'playing', 'ended']) {
      audio.dispatchEvent(new Event(event));
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.track()).toBeNull(); expect(service.phase()).toBe('idle');
    expect(service.positionSeconds()).toBe(0); expect(service.durationSeconds()).toBe(0);
    expect(service.playing()).toBe(false); expect(service.requested()).toBe(false);
    expect(service.volume()).toBe(0.35); expect(service.muted()).toBe(true);
    const calls = audio.play.mock.calls.length;
    await service.resume(); expect(audio.play).toHaveBeenCalledTimes(calls);
    await service.play(track); expect(service.requested()).toBe(true);
  });

  it('ignores a rejected play promise after the selection was removed', async () => {
    let reject!: (reason: unknown) => void;
    audio.play.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const pending = service.play(track);
    service.clear(); reject(new DOMException('gone', 'NotAllowedError'));
    await pending;
    expect(service.phase()).toBe('idle'); expect(service.error()).toBeNull();
  });

  it.each([0, 0.25, 1])('restores volume %s before loading audio', value => {
    service.setVolume(value);
    reloadPlayer();
    expect(audio.volume).toBe(value);
    expect(service.volume()).toBe(value);
    service.load(track);
    expect(audio.volume).toBe(value);
  });

  it('restores mute without losing the chosen volume', () => {
    service.setVolume(0.3);
    service.toggleMuted();
    reloadPlayer();
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBe(0.3);
    service.toggleMuted();
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.3);
    service.toggleMuted();
    service.setVolume(0.2);
    expect(audio.muted).toBe(false);
  });

  it.each(['{broken', 'null', '{"volume":2,"muted":false}', '{"volume":"0.9","muted":false}'])('ignores invalid saved output: %s', raw => {
    saved = raw;
    reloadPlayer();
    expect(audio.volume).toBe(0.8);
    expect(audio.muted).toBe(false);
  });

  it('still plays and adjusts volume when browser storage is blocked', async () => {
    storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    storage.setItem.mockImplementation(() => { throw new Error('full'); });
    reloadPlayer();
    service.setVolume(0.2);
    await service.play(track);
    expect(audio.volume).toBe(0.2);
    expect(service.requested()).toBe(true);
  });

  it('ignores non-finite input and clamps finite input', () => {
    service.setVolume(NaN); service.setVolume(Infinity);
    expect(service.volume()).toBe(0.8);
    service.setVolume(-1); expect(audio.volume).toBe(0);
    service.setVolume(2); expect(audio.volume).toBe(1);
  });

  it('shares preferences between tabs in one browser, not through playback state', () => {
    saved = JSON.stringify({ volume: 0.15, muted: true });
    window.dispatchEvent(new StorageEvent('storage', { key: AUDIO_OUTPUT_STORAGE_KEY }));
    expect(audio.volume).toBe(0.15);
    expect(audio.muted).toBe(true);
    service.load(track); service.pause(); service.load({ ...track, id: 'another-track' });
    expect(audio.volume).toBe(0.15);
    expect(audio.muted).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('permission waiting never changes or persists volume/mute', async () => {
    service.setVolume(0.25);
    storage.setItem.mockClear();
    audio.play.mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'));
    await service.play(track);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.25);
    expect(storage.setItem).not.toHaveBeenCalled();
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

    await vi.advanceTimersByTimeAsync(115);
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

    await vi.advanceTimersByTimeAsync(350);

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
    await vi.advanceTimersByTimeAsync(115);
    audio.readyState = 4;
    audio.dispatchEvent(new Event('loadedmetadata'));

    for (let elapsed = 0; elapsed < 3_100; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      audio.currentTime += 0.1;
      audio.paused = false;
      audio.dispatchEvent(new Event('timeupdate'));
    }

    await vi.advanceTimersByTimeAsync(115);
    await vi.advanceTimersByTimeAsync(130);

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
    await vi.advanceTimersByTimeAsync(15);
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

  it('ignores stale end events and reports a real end only once with its final position', async () => {
    const ended = vi.fn();
    service.onEnded(ended);
    service.load(track);
    await service.resume();
    audio.dispatchEvent(new Event('ended'));
    expect(ended).not.toHaveBeenCalled();
    expect(service.requested()).toBe(true);
    audio.currentTime = 180;
    audio.ended = true;
    audio.dispatchEvent(new Event('ended'));
    audio.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce();
    expect(service.positionSeconds()).toBe(180);
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

  it('classifies autoplay as a blocked start without retrying or inventing progress', async () => {
    const failed=vi.fn(); service.onPlaybackFailed(failed);
    const interaction=vi.fn(); service.onInteractionRequired(interaction);
    audio.play.mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'));
    await service.play(track);
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.load).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(interaction).toHaveBeenCalledOnce();
    expect(service.phase()).toBe('awaiting_interaction');
    expect(service.error()).toBeNull();
    expect(audio.play).toHaveBeenCalledOnce();
    await service.resume();
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('cancels scheduled backoff when a different track is loaded', async () => {
    await service.play(track);
    await vi.advanceTimersByTimeAsync(101);
    service.load({...track,id:'replacement'});
    await service.resume();
    await vi.advanceTimersByTimeAsync(20);
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.src).toContain('replacement/stream');
  });

  it('preserves recovered audio instead of reopening its healthy buffer during backoff', async () => {
    await service.play(track);
    await vi.advanceTimersByTimeAsync(101);
    audio.currentTime = 1;
    audio.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(14);
    expect(service.playing()).toBe(true);
    expect(audio.load).toHaveBeenCalledOnce();
    // A later real stall still has a watchdog; cancelling must not disable it.
    await vi.advanceTimersByTimeAsync(115);
    expect(audio.load).toHaveBeenCalledTimes(2);
  });

  it('checks a provider cooldown before reopening a failed stream', async () => {
    const failed = vi.fn(); service.onPlaybackFailed(failed);
    service.onRecoveryCheck(async () => ({code:'service_unavailable',retryAfterMs:60000}));
    await service.play(track);
    await vi.advanceTimersByTimeAsync(115);
    expect(audio.load).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({code:'service_unavailable',retryAfterMs:60000}));
  });

  it('retains the last heard position if a reopened source resets currentTime before metadata', async () => {
    const failed=vi.fn(); service.onPlaybackFailed(failed);
    await service.play(track);
    audio.readyState=4; audio.currentTime=5; audio.dispatchEvent(new Event('timeupdate'));
    audio.load.mockImplementation(()=>{
      audio.readyState=0; audio.currentTime=0; audio.dispatchEvent(new Event('timeupdate'));
    });
    await vi.advanceTimersByTimeAsync(115);
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(service.positionSeconds()).toBe(5);
    Object.defineProperty(audio,'error',{value:{code:3}});
    audio.dispatchEvent(new Event('error'));
    expect(failed).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({positionMs:5000}));
  });

  it('ignores diagnostics from a cancelled recovery after another track starts', async () => {
    let diagnose!: (value: {code:'service_unavailable'}) => void;
    service.onRecoveryCheck(() => new Promise(resolve => { diagnose = resolve; }));
    await service.play(track);
    await vi.advanceTimersByTimeAsync(101);
    await service.play({...track,id:'replacement'});
    diagnose({code:'service_unavailable'});
    await vi.advanceTimersByTimeAsync(0);
    expect(service.requested()).toBe(true);
    expect(service.phase()).not.toBe('error');
  });

  it('does not restart healthy audio when progress arrives during the diagnostic lookup', async () => {
    let diagnose!: (value: null) => void;
    service.onRecoveryCheck(() => new Promise(resolve => { diagnose = resolve; }));
    await service.play(track); await vi.advanceTimersByTimeAsync(101);
    audio.currentTime=1; audio.dispatchEvent(new Event('timeupdate'));
    diagnose(null); await vi.advanceTimersByTimeAsync(20);
    expect(audio.load).toHaveBeenCalledOnce();
    expect(service.playing()).toBe(true);
  });

  it('provides a fresh recovery episode after long healthy playback', async () => {
    await service.play(track);
    for(let i=0;i<520;i++) {
      await vi.advanceTimersByTimeAsync(50);
      audio.currentTime+=0.1; audio.dispatchEvent(new Event('timeupdate'));
    }
    await vi.advanceTimersByTimeAsync(115);
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(service.requested()).toBe(true);
  });

  it('ignores an old play rejection even when retrying the same file', async () => {
    let reject!: (error:unknown)=>void;
    audio.play.mockImplementationOnce(()=>new Promise<void>((_resolve,rejection)=>{reject=rejection;}));
    const first=service.play(track);
    service.pause();
    await service.resume();
    reject(new DOMException('old attempt','AbortError'));
    await first;
    expect(service.requested()).toBe(true);
    expect(service.phase()).not.toBe('error');
  });

  it('a late permission rejection after explicit pause does not reinstate waiting', async () => {
    let reject!: (error: unknown) => void;
    audio.play.mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }));
    const pending = service.play(track);
    service.pause();
    reject(new DOMException('old permission attempt','NotAllowedError'));
    await pending;
    expect(service.phase()).toBe('paused');
    expect(service.requested()).toBe(false);
  });

  it('stops a stalled new track at the shared recovery deadline without another source load', async () => {
    const failed = vi.fn();
    service.onPlaybackFailed(failed);
    service.load(track);
    service.setRecoveryDeadline(Date.now() + 50);
    await service.resume();
    await vi.advanceTimersByTimeAsync(51);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0][1].code).toBe('timeout');
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it('does not interrupt progressing audio at a recovery deadline', async () => {
    await service.play(track);
    service.setRecoveryDeadline(Date.now() + 50);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20);
      audio.currentTime += 0.1;
      audio.dispatchEvent(new Event('timeupdate'));
    }
    expect(service.playing()).toBe(true);
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it('cancels backoff at the shared deadline rather than starting an expired attempt', async () => {
    await service.play(track);
    service.setRecoveryDeadline(Date.now() + 105);
    await vi.advanceTimersByTimeAsync(110);
    expect(service.phase()).toBe('error');
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it('does not restore an old deadline after sustained progress and a repeated snapshot', async () => {
    await service.play(track);
    const deadline = Date.now() + 50;
    service.setRecoveryDeadline(deadline);
    for (let i = 0; i < 160; i++) {
      await vi.advanceTimersByTimeAsync(20);
      audio.currentTime += 0.1;
      audio.dispatchEvent(new Event('timeupdate'));
    }
    service.setRecoveryDeadline(deadline);
    await vi.advanceTimersByTimeAsync(115);
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(service.requested()).toBe(true);
  });
});

class FakeAudio extends EventTarget {
  readonly removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  preload = '';
  volume = 1;
  src = '';
  currentTime = 0;
  duration = 180;
  readyState = 0;
  networkState = 1;
  paused = true;
  ended = false;
  muted = false;

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
  genres: [],
  favorite: false,
};
