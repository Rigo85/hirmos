import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '../core/session.store';
import { LocalExtrasService } from '../offline/local-extras.service';
import { LocalCoverComponent } from './local-cover.component';

it('only renders local blobs, discards late account results and revokes URLs on replacement/destruction',async()=>{
  const owner=signal('first'),pending:Array<(blob:Blob|null)=>void>=[];
  const cover=vi.fn(async()=>new Promise<Blob|null>(resolve=>pending.push(resolve)));
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local-cover');
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>undefined);
  TestBed.configureTestingModule({imports:[LocalCoverComponent],providers:[{provide:SessionStore,useValue:{localOwner:owner}},
    {provide:LocalExtrasService,useValue:{cover}}]});
  const f=TestBed.createComponent(LocalCoverComponent);f.componentRef.setInput('reference','track');f.detectChanges();
  owner.set('second');f.detectChanges();
  pending[0](new Blob(['old']));await Promise.resolve();await Promise.resolve();f.detectChanges();
  expect(create).not.toHaveBeenCalled();
  pending[1](new Blob(['current']));await vi.waitFor(()=>expect(create).toHaveBeenCalledOnce());f.detectChanges();
  expect(f.nativeElement.querySelector('img').getAttribute('src')).toBe('blob:local-cover');
  f.componentRef.setInput('reference',null);f.detectChanges();expect(revoke).toHaveBeenCalledOnce();
  expect(f.nativeElement.querySelector('img')).toBeNull();f.destroy();create.mockRestore();revoke.mockRestore();
});
