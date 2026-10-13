import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {LocalProfileStore} from './local-profile.store';
import {PlaybackModeService} from './playback-mode.service';
function setup(){
  const offline=signal(false),value=signal({user:{id:'synthetic'}}),conflict=signal(false);
  const local={offline,value,conflict,refresh:vi.fn(),setMode:vi.fn(()=>offline.set(true))};
  TestBed.configureTestingModule({providers:[PlaybackModeService,{provide:LocalProfileStore,useValue:local}]});
  return {local,service:TestBed.inject(PlaybackModeService)};
}
afterEach(()=>{TestBed.resetTestingModule();sessionStorage.removeItem('hirmos.player-id:synthetic');sessionStorage.removeItem('hirmos.local-exit:device');});
it('cold local entry needs no socket and fences any persisted online identity',async()=>{
  const f=setup();sessionStorage.setItem('hirmos.player-id:synthetic','device');
  await f.service.enterLocal();expect(f.local.offline()).toBe(true);
  expect(sessionStorage.getItem('hirmos.local-exit:device')).toBe(String(Number.MAX_SAFE_INTEGER));
});
it('coalesces concurrent entries and leaves online before committing local mode',async()=>{
  const f=setup();let resolve!:()=>void;
  const leave=vi.fn(()=>new Promise<void>(done=>resolve=done));f.service.registerOnline(leave);
  const one=f.service.enterLocal(),two=f.service.enterLocal();expect(f.local.offline()).toBe(false);
  resolve();await Promise.all([one,two]);expect(leave).toHaveBeenCalledOnce();expect(f.local.setMode).toHaveBeenCalledOnce();
});
it('does not change another account after a delayed transition',async()=>{
  const f=setup();let resolve!:()=>void;f.service.registerOnline(()=>new Promise<void>(done=>resolve=done));
  const op=f.service.enterLocal();f.local.value.set({user:{id:'other'}});resolve();
  await expect(op).rejects.toThrow('ACCOUNT_CHANGED');expect(f.local.setMode).not.toHaveBeenCalled();
});
