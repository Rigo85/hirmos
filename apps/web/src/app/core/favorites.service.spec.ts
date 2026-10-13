import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import { FavoritesService } from './favorites.service';
import {signal} from '@angular/core';
import {SessionStore} from './session.store';

const owner=signal('account-a'), session=signal<object|null>({}), allowed=signal(true);
let generation=0;
const identity={session,localOwner:owner,canUseRemote:allowed,requestGeneration:()=>generation};

describe('FavoritesService', () => {
  beforeEach(() => {
    owner.set('account-a');session.set({});allowed.set(true);generation=0;
    TestBed.configureTestingModule({providers: [provideHttpClient(), provideHttpClientTesting(),{provide:SessionStore,useValue:identity}]});
  });
  afterEach(()=>vi.useRealTimers());

  it('does not retain a favorite override after switching accounts',async()=>{
    const service=TestBed.inject(FavoritesService),http=TestBed.inject(HttpTestingController);
    const pending=service.toggle(track());http.expectOne('/api/library/tracks/track-id/favorite').flush({favorite:true});await pending;
    owner.set('account-b');session.set({});generation++;
    expect(service.isFavorite(track())).toBe(false);
  });

  it.each([true,false])('ignores an old response or rollback without clearing new pending state: %s',async(success)=>{
    const service=TestBed.inject(FavoritesService),http=TestBed.inject(HttpTestingController);
    const first=service.toggle(track()),old=http.expectOne('/api/library/tracks/track-id/favorite');
    owner.set('account-b');session.set({});generation++;
    const second=service.toggle(track()),fresh=http.expectOne('/api/library/tracks/track-id/favorite');
    expect(fresh.request.body).toEqual({favorite:true});
    if(success)old.flush({favorite:false});else old.flush({}, {status:502,statusText:'Synthetic failure'});
    expect(await first).toBeNull();expect(service.isPending(track().id)).toBe(true);
    expect(service.isFavorite(track())).toBe(true);expect(service.error()).toBeNull();
    fresh.flush({favorite:true});await second;http.verify();
  });

  it('resets on same-account renewal and refuses offline mutations',async()=>{
    const service=TestBed.inject(FavoritesService),http=TestBed.inject(HttpTestingController);
    const pending=service.toggle(track());http.expectOne('/api/library/tracks/track-id/favorite').flush({favorite:true});await pending;
    session.set(null);generation++;session.set({});generation++;
    expect(service.isFavorite(track())).toBe(false);
    allowed.set(false);expect(await service.toggle(track())).toBeNull();http.expectNone('/api/library/tracks/track-id/favorite');
  });

  it('times out and releases pending state without retrying an uncertain mutation',async()=>{
    vi.useFakeTimers();const service=TestBed.inject(FavoritesService),http=TestBed.inject(HttpTestingController);
    const pending=service.toggle(track()),request=http.expectOne('/api/library/tracks/track-id/favorite');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();expect(request.cancelled).toBe(true);expect(service.isPending(track().id)).toBe(false);
    expect(service.error()).toContain('favoritos');http.verify();
  });

  it('updates optimistically and keeps the confirmed personal state', async () => {
    const service = TestBed.inject(FavoritesService);
    const http = TestBed.inject(HttpTestingController);
    const result = service.toggle(track());

    expect(service.isFavorite(track())).toBe(true);
    const request = http.expectOne('/api/library/tracks/track-id/favorite');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ favorite: true });
    request.flush({ reference: 'track-id', favorite: true });

    await expect(result).resolves.toBe(true);
    expect(service.isFavorite(track())).toBe(true);
    expect(service.error()).toBeNull();
  });

  it('rolls back and reports a failed mutation', async () => {
    const service = TestBed.inject(FavoritesService);
    const http = TestBed.inject(HttpTestingController);
    const result = service.toggle(track());
    http.expectOne('/api/library/tracks/track-id/favorite').flush({}, { status: 502, statusText: 'Bad gateway' });

    await expect(result).resolves.toBeNull();
    expect(service.isFavorite(track())).toBe(false);
    expect(service.error()).toContain('favoritos');
  });
});

function track(): Track {
  return {
    id: 'track-id', title: 'Song', artist: 'Artist', artistId: null, album: 'Album',
    albumId: null, durationMs: 180_000, coverUrl: null, year: 2026, genres: [], favorite: false,
  };
}
