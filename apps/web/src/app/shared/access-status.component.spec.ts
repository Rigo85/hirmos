import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { SessionStore } from '../core/session.store';
import { PROFILE_STORAGE_KEY } from '../core/local-profile.store';
import { AccessStatusComponent } from './access-status.component';

const key='hirmos.test.access-notice';
function setup(){
  localStorage.removeItem(key);
  TestBed.configureTestingModule({imports:[AccessStatusComponent],providers:[provideRouter([]),provideHttpClient(),provideHttpClientTesting(),{provide:PROFILE_STORAGE_KEY,useValue:key}]});
  const store=TestBed.inject(SessionStore);
  store.acceptAuthenticatedSession({user:{id:'11111111-1111-4111-8111-111111111111',displayName:'Synthetic',email:'listener@example.test',role:'user'},expiresAt:new Date(Date.now()+86400000).toISOString()});
  const fixture=TestBed.createComponent(AccessStatusComponent);fixture.detectChanges();
  return {store,fixture,root:fixture.nativeElement as HTMLElement};
}
afterEach(()=>{TestBed.resetTestingModule();localStorage.removeItem(key);});

it('shows a single neutral renewal action without navigating or changing mode',()=>{
  const {store,fixture,root}=setup();store.requireRenewal();fixture.detectChanges();
  expect(root.querySelectorAll('section')).toHaveLength(1);
  expect(root.querySelector('[role="alert"]')).toBeNull();
  root.querySelector<HTMLButtonElement>('button')!.click();
  expect(store.renewalRequested()).toBe(true);
  expect(store.local.offline()).toBe(false);
  expect(root.querySelector('a')?.getAttribute('href')).toBe('/local');
});
it('keeps reconnect notices dismissed across retries, but exposes a different cause',()=>{
  const {store,fixture,root}=setup();
  store.deviceConnection.set('interrupted');fixture.detectChanges();
  root.querySelector<HTMLButtonElement>('[aria-label="Cerrar aviso de acceso"]')!.click();fixture.detectChanges();
  expect(root.querySelector('section')).toBeNull();
  store.deviceConnection.set('interrupted');store.checking.set(true);fixture.detectChanges();
  expect(root.querySelector('section')).toBeNull();
  expect(root.textContent).toContain('Ver detalles');
  store.requireRenewal();fixture.detectChanges();
  expect(root.querySelector('section')).not.toBeNull();
  expect(root.textContent).toContain('Renovar acceso');
});
it('does not nag for online authentication in chosen offline mode',()=>{
  const {store,fixture,root}=setup();store.requireRenewal();store.local.setMode('offline');fixture.detectChanges();
  expect(root.textContent?.trim()).toBe('');
});
it('keeps a permissions problem separate from session expiry',()=>{
  const {store,fixture,root}=setup();store.remoteStatus.set('forbidden');fixture.detectChanges();
  expect(root.textContent).toContain('no cambia tus permisos');
  expect(root.textContent).not.toContain('Renovar acceso');
});
it('shows connection checks as checks, never as a demand to log in',()=>{
  const {store,fixture,root}=setup();store.remoteStatus.set('unreachable');fixture.detectChanges();
  expect(root.textContent).toContain('Comprobar acceso');
  expect(root.textContent).not.toContain('Renovar acceso');
  expect(store.needsRenewal()).toBe(false);
});
