import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController,provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PlaylistsService } from './playlists.service';
describe('playlist delivery',()=>{
  it('does not retry a conflicting mutation',async()=>{
    TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});
    const service=TestBed.inject(PlaylistsService), http=TestBed.inject(HttpTestingController);
    const promise=service.command({action:'create',commandId:'frozen-id',name:'List',description:''});
    const rejection=expect(promise).rejects.toMatchObject({status:409});
    http.expectOne('/api/playlists/commands').flush({message:'Conflict'},{status:409,statusText:'Conflict'});
    await rejection;http.verify();expect(service.changed()).toBe(0);
  });
  it('does not shortcut Retry-After with its own retry delay',async()=>{
    TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});
    const service=TestBed.inject(PlaylistsService),http=TestBed.inject(HttpTestingController);
    const promise=service.command({action:'create',commandId:'frozen-id',name:'List',description:''});
    const rejection=expect(promise).rejects.toMatchObject({status:503});
    http.expectOne('/api/playlists/commands').flush({},{status:503,statusText:'Unavailable',headers:{'retry-after':'30'}});
    await rejection;http.verify();
  });
});
