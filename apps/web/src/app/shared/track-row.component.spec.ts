import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { AppIconComponent } from './app-icon.component';
import { TrackRowComponent } from './track-row.component';
import { FavoritesService } from '../core/favorites.service';
import { DownloadsService } from '../offline/downloads.service';
import { QueueMenuService } from '../core/queue-menu.service';

describe('TrackRowComponent', () => {
  const snapshot = signal<{ currentTrackRef: string | null; status: 'playing' | 'paused' }>({
    currentTrackRef: null,
    status: 'paused',
  });
  const toggle = vi.fn();
  const favorite = signal(false);
  const toggleFavorite = vi.fn(async () => {
    favorite.update((value) => !value);
    return favorite();
  });

  beforeEach(async () => {
    snapshot.set({ currentTrackRef: null, status: 'paused' });
    toggle.mockReset();
    favorite.set(false);
    toggleFavorite.mockClear();
    await TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [
        provideRouter([]),
        { provide: DownloadsService, useValue:{ready:()=>new Set()} },
        { provide: PlaybackSyncService, useValue: { snapshot, toggle } },
        { provide: FavoritesService, useValue: {
          isFavorite: () => favorite(), isPending: () => false, toggle: toggleFavorite,
        } },
      ],
    }).compileComponents();
  });

  it('links available artist and album metadata without using them as play controls', () => {
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    fixture.componentRef.setInput('showCover', true);
    const played = vi.fn();
    fixture.componentInstance.playTrack.subscribe(played);
    fixture.detectChanges();

    const links = fixture.nativeElement.querySelectorAll('.track-row__meta a') as NodeListOf<HTMLAnchorElement>;
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/artists/artist-id');
    expect(links[1].getAttribute('href')).toBe('/albums/album-id');

    fixture.nativeElement.querySelector('.track-row__title').click();
    expect(played).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-id' }));
  });

  it('keeps metadata as text when the source does not provide navigable ids', () => {
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', { ...track(), artistId: null, albumId: null });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.track-row__meta a')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.track-row__meta').textContent.replace(/\s/g, ''))
      .toBe('Artista·Álbum');
  });
  it('only marks redundant mobile album metadata when context, ids and names agree',()=>{
    const fixture=TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track',track());
    fixture.componentRef.setInput('presentation','album');
    fixture.componentRef.setInput('albumContext',{id:'album-id',name:'Álbum',artist:'Artista',artistId:'artist-id'});
    fixture.detectChanges();
    const meta=()=>fixture.nativeElement.querySelector('.track-row__meta');
    expect(meta().classList).toContain('track-row__meta--same-artist');
    expect(meta().classList).toContain('track-row__meta--same-album');
    // Preserve DOM metadata for desktop; CSS omission is mobile and context-specific.
    expect(meta().textContent).toContain('Artista');
    for(const value of [{...track(),artist:'Artista con invitado'}, {...track(),artistId:null}]){
      fixture.componentRef.setInput('track',value);fixture.detectChanges();
      expect(meta().classList).not.toContain('track-row__meta--same-artist');
    }
    fixture.componentRef.setInput('track',track());
    fixture.componentRef.setInput('presentation','standard');fixture.detectChanges();
    expect(meta().classList).not.toContain('track-row__meta--same-album');
    expect(meta().classList).not.toContain('track-row__meta--same-artist');
    fixture.componentRef.setInput('presentation','album');
    fixture.componentRef.setInput('albumContext',{id:'other',name:'Álbum',artist:'Artista',artistId:'artist-id'});
    fixture.detectChanges();expect(meta().classList).not.toContain('track-row__meta--same-album');
  });
  it('keeps the download indicator outside the title/play button and in the trailing area',()=>{
    const fixture=TestBed.createComponent(TrackRowComponent);fixture.componentRef.setInput('track',track());fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.track-row__title app-download-badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('.track-row__trailing app-download-badge')).not.toBeNull();
  });
  it('offers album favorite management through the menu and an exact compact duration',()=>{
    const fixture=TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track',{...track(),durationMs:263_000});
    fixture.componentRef.setInput('presentation','album');fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.track-row__compact-status time').textContent).toBe('4:23');
    const played=vi.fn();fixture.componentInstance.playTrack.subscribe(played);
    fixture.nativeElement.querySelector('.track-row__playlist').click();
    expect(TestBed.inject(QueueMenuService).showFavorite()).toBe(true);
    expect(played).not.toHaveBeenCalled();expect(toggleFavorite).not.toHaveBeenCalled();
    TestBed.inject(QueueMenuService).open([track()]);
    expect(TestBed.inject(QueueMenuService).showFavorite()).toBe(false);
  });

  it('highlights and pauses the current playing track instead of selecting it again', () => {
    snapshot.set({ currentTrackRef: 'track-id', status: 'playing' });
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    const played = vi.fn();
    fixture.componentInstance.playTrack.subscribe(played);
    fixture.detectChanges();

    expect(fixture.nativeElement.classList).toContain('track-row--current');
    expect(fixture.nativeElement.classList).toContain('track-row--playing');
    expect(fixture.nativeElement.getAttribute('aria-current')).toBe('true');
    expect(fixture.nativeElement.querySelector('.track-row__play').getAttribute('aria-label'))
      .toBe('Pausar Canción');
    expect(fixture.debugElement.query(By.directive(AppIconComponent)).componentInstance.name())
      .toBe('pause');

    fixture.nativeElement.querySelector('.track-row__play').click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(played).not.toHaveBeenCalled();
  });

  it('keeps a paused current track highlighted and offers play', () => {
    snapshot.set({ currentTrackRef: 'track-id', status: 'paused' });
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    fixture.detectChanges();

    expect(fixture.nativeElement.classList).toContain('track-row--current');
    expect(fixture.nativeElement.classList).not.toContain('track-row--playing');
    expect(fixture.nativeElement.querySelector('.track-row__play').getAttribute('aria-label'))
      .toBe('Reproducir Canción');
    expect(fixture.debugElement.query(By.directive(AppIconComponent)).componentInstance.name())
      .toBe('play');
  });

  it('marks a track as favorite without starting playback', async () => {
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    const played = vi.fn();
    const changed = vi.fn();
    fixture.componentInstance.playTrack.subscribe(played);
    fixture.componentInstance.favoriteChange.subscribe(changed);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.track-row__favorite') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    await fixture.whenStable(); fixture.detectChanges();

    expect(toggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-id' }));
    expect(changed).toHaveBeenCalledWith(true);
    expect(played).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});

function track(): Track {
  return {
    id: 'track-id', title: 'Canción', artist: 'Artista', artistId: 'artist-id',
    album: 'Álbum', albumId: 'album-id', durationMs: 180_000, coverUrl: null,
    year: 2026, genres: [], favorite: false,
  };
}
