import { Injectable, signal } from '@angular/core';
import type { Track } from '@hirmos/contracts';

@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  private readonly audio = new Audio();
  readonly track = signal<Track | null>(null);
  readonly playing = signal(false);
  readonly positionSeconds = signal(0);
  readonly durationSeconds = signal(0);
  readonly error = signal<string | null>(null);
  readonly volume = signal(0.8);
  private endedHandler: (() => void) | null = null;

  public constructor() {
    this.audio.preload = 'metadata';
    this.audio.addEventListener('play', () => this.playing.set(true));
    this.audio.addEventListener('pause', () => this.playing.set(false));
    this.audio.volume = this.volume();
    this.audio.addEventListener('ended', () => {
      this.playing.set(false);
      this.endedHandler?.();
    });
    this.audio.addEventListener('timeupdate', () => this.positionSeconds.set(this.audio.currentTime));
    this.audio.addEventListener('durationchange', () => {
      this.durationSeconds.set(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    });
    this.audio.addEventListener('error', () => {
      this.playing.set(false);
      this.error.set('No pudimos reproducir esta canción.');
    });
  }

  public load(track: Track): void {
    this.error.set(null);
    if (this.track()?.id !== track.id) {
      this.track.set(track);
      this.audio.src = `/api/music/tracks/${encodeURIComponent(track.id)}/stream`;
      this.updateMediaSession(track);
    }
  }

  public async play(track: Track): Promise<void> {
    this.load(track);
    await this.resume();
  }

  public async toggle(): Promise<void> {
    if (this.audio.paused) await this.resume();
    else this.pause();
  }

  public pause(): void {
    this.audio.pause();
  }

  public seek(seconds: number): void {
    const position = Math.max(0, seconds);
    if (this.audio.readyState > 0) {
      this.audio.currentTime = position;
      return;
    }
    this.audio.addEventListener('loadedmetadata', () => {
      this.audio.currentTime = Math.min(position, this.audio.duration || position);
    }, { once: true });
  }

  public setVolume(value: number): void {
    const volume = Math.min(1, Math.max(0, value));
    this.audio.volume = volume;
    this.volume.set(volume);
  }

  public onEnded(handler: () => void): void {
    this.endedHandler = handler;
  }

  public async resume(): Promise<void> {
    if (!this.track()) return;
    try {
      await this.audio.play();
    } catch {
      this.error.set('El navegador no permitió iniciar la reproducción.');
    }
  }

  private updateMediaSession(track: Track): void {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: track.coverUrl ? [{ src: track.coverUrl }] : [],
    });
  }
}
