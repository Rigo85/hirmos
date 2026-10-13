import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { type SessionResponse } from '@hirmos/contracts';
import { LocalProfileStore, PROFILE_STORAGE_KEY, readLocalProfile } from './local-profile.store';
import { parseSessionResponse, SessionStore } from './session.store';
import { localModeInterceptor } from './local-mode.interceptor';
import { provideRouter, Router, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { authGuard } from './auth.guard';

const key = 'hirmos.test.local-session';
let controller: HttpTestingController;
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const response = (id = owner): SessionResponse => ({
  user: { id, email: 'listener@example.test', displayName: 'Listener', role: 'user' },
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
function setup() {
  localStorage.removeItem(key);
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([localModeInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: PROFILE_STORAGE_KEY, useValue: key },
    ],
  });
  const local = TestBed.inject(LocalProfileStore),
    store = TestBed.inject(SessionStore),
    http = TestBed.inject(HttpTestingController);
  controller = http;
  store.acceptAuthenticatedSession(response());
  TestBed.tick();
  return { local, store, http, client: TestBed.inject(HttpClient) };
}
afterEach(() => {
  controller?.verify();
  TestBed.resetTestingModule();
  localStorage.removeItem(key);
});
const sent = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
};

it('persists only local identity: no role, password, token or authority', () => {
  const { store } = setup();
  store.requireRenewal();
  const data = readLocalProfile(key)!;
  expect(data.user).toEqual({ id: owner, email: 'listener@example.test', displayName: 'Listener' });
  expect(data.remote).toBe('required');
  expect(store.localOwner()).toBe(owner);
  expect(store.session()).toBeNull();
  expect(JSON.stringify(data)).not.toMatch(/password|token|role/);
});
it('an unchanged session check does not broadcast an auth transition that could stop another tab', async () => {
  const { local, store, http } = setup();
  const current = store.session()!,
    revision = local.value()?.revision;
  const checked = store.checkRemote();
  http.expectOne('/api/auth/session').flush(current);
  await checked;
  expect(local.value()?.revision).toBe(revision);
  expect(store.canUseRemote()).toBe(true);
});
it('rejects malformed remote metadata instead of adopting a fabricated local profile', () => {
  setup();
  expect(() =>
    parseSessionResponse({
      user: { id: owner, email: 'listener@example.test', displayName: 'Listener', role: 'owner' },
      expiresAt: 'tomorrow',
    }),
  ).toThrow('INVALID_SESSION');
  expect(() => parseSessionResponse({ user: null })).toThrow('INVALID_SESSION');
  const valid = response();
  expect(parseSessionResponse({ ...valid, token: 'never-persist' })).toEqual(valid);
});
it('honors same-account closure from another tab without deleting local identity or polling', async () => {
  const { local, store, http } = setup();
  localStorage.setItem(
    key,
    JSON.stringify({ ...local.value()!, remote: 'closed', revision: crypto.randomUUID() }),
  );
  window.dispatchEvent(new StorageEvent('storage', { key }));
  TestBed.tick();
  expect(store.session()).toBeNull();
  expect(store.localOwner()).toBe(owner);
  expect(await store.load()).toBeNull();
  http.expectNone('/api/auth/session');
});
it('rejects a late successful account data response after a session transition', async () => {
  const { store, http, client } = setup();
  const op = firstValueFrom(client.get('/api/music/search')).catch((e) => e);
  const req = http.expectOne('/api/music/search');
  store.requireRenewal();
  req.flush({ tracks: [] });
  expect(await op).toMatchObject({ statusText: 'STALE_ACCESS' });
});
it('accepts a confirmed same-account revocation even when its socket notification arrives first',async()=>{
  const {store,http,client}=setup();
  const pending=firstValueFrom(client.delete('/api/account/sessions/synthetic'));
  const req=http.expectOne('/api/account/sessions/synthetic');store.requireRenewal();req.flush(null);
  expect(await pending).toBeNull();expect(store.needsRenewal()).toBe(true);
});
it('observes a durable close even if its storage notification and Angular effects have not run', async () => {
  const { local, store, http } = setup();
  const pending = store.checkRemote();
  const request = http.expectOne('/api/auth/session');
  localStorage.setItem(
    key,
    JSON.stringify({ ...local.value()!, remote: 'closed', revision: crypto.randomUUID() }),
  );
  request.flush(response());
  await pending;
  expect(store.session()).toBeNull();
  expect(readLocalProfile(key)?.remote).toBe('closed');
  expect(store.localOwner()).toBe(owner);
});
it('does not let a pending renewal overwrite a newer same-account local transition', async () => {
  const { local, store, http } = setup();
  const pending = store.renew('password').catch((e) => e);
  await sent();
  const request = http.expectOne('/api/auth/renew');
  localStorage.setItem(
    key,
    JSON.stringify({ ...local.value()!, remote: 'closed', revision: crypto.randomUUID() }),
  );
  request.flush(response());
  expect(await pending).toBeInstanceOf(Error);
  expect(readLocalProfile(key)?.remote).toBe('closed');
  expect(store.renewed()).toBe(0);
});
it('offline with Internet makes no automatic API calls; renewal preserves offline mode and owner', async () => {
  const { store, local, http, client } = setup();
  local.setMode('offline');
  TestBed.tick();
  expect(await store.load()).toBeNull();
  await expect(firstValueFrom(client.get('/api/music/tracks'))).rejects.toMatchObject({
    status: 0,
    statusText: 'LOCAL_MODE',
  });
  http.expectNone('/api/music/tracks');
  const renewal = store.renew('synthetic-password');
  await sent();
  const req = http.expectOne('/api/auth/renew');
  expect(req.request.body.expectedUserId).toBe(owner);
  req.flush(response());
  await renewal;
  TestBed.tick();
  expect(local.offline()).toBe(true);
  expect(store.canUseRemote()).toBe(false);
  expect(store.localOwner()).toBe(owner);
  http.expectNone('/api/auth/session');
});
it.each([401, 403, 429, 503, 0])(
  'renewal failure %i preserves local mode, profile and retry choice',
  async (status) => {
    const { store, local, http } = setup();
    local.setMode('offline');
    TestBed.tick();
    store.requestRenewal();
    const result = store.renew('wrong').catch((e) => e);
    await sent();
    const req = http.expectOne('/api/auth/renew');
    if (status === 0) req.error(new ProgressEvent('error'));
    else req.flush({}, { status, statusText: 'Failure', headers: { 'retry-after': '120' } });
    expect(await result).toBeInstanceOf(Error);
    expect(local.offline()).toBe(true);
    expect(store.localOwner()).toBe(owner);
    expect(store.renewalRequested()).toBe(true);
    expect(store.busy()).toBe(false);
  },
);
it('dismissing pending renewal does not exit the local screen or force online when it succeeds', async () => {
  const { store, local, http } = setup();
  local.setMode('offline');
  TestBed.tick();
  store.requestRenewal();
  const op = store.renew('password');
  await sent();
  store.dismissRenewal();
  http.expectOne('/api/auth/renew').flush(response());
  await op;
  expect(store.renewalRequested()).toBe(false);
  expect(local.offline()).toBe(true);
});
it('a stale remote validation cannot undo confirmed logout', async () => {
  const { store, http } = setup();
  const check = store.checkRemote();
  const old = http.expectOne('/api/auth/session');
  const logout = store.logout();
  await sent();
  const req = http.expectOne('/api/auth/logout');
  expect(req.request.body.expectedUserId).toBe(owner);
  req.flush(null);
  await logout;
  old.flush(response());
  await check;
  expect(store.session()).toBeNull();
  expect(store.local.value()?.remote).toBe('closed');
});
it('unconfirmed logout is not reported as closed and never deletes the local profile', async () => {
  const { store, http } = setup();
  const result = store.logout().catch((e) => e);
  await sent();
  http.expectOne('/api/auth/logout').error(new ProgressEvent('error'));
  expect((await result).message).toContain('No pudimos confirmar el cierre');
  expect(store.local.value()?.remote).toBe('unknown');
  expect(store.localOwner()).toBe(owner);
});
it('late 401 from before renewal cannot invalidate the new session', async () => {
  const { store, http, client } = setup();
  const old = firstValueFrom(client.get('/api/music/search')).catch((e) => e);
  const req = http.expectOne('/api/music/search');
  const op = store.renew('password');
  await sent();
  http.expectOne('/api/auth/renew').flush(response());
  await op;
  req.flush({}, { status: 401, statusText: 'Unauthorized' });
  await old;
  expect(store.session()?.user.id).toBe(owner);
  expect(store.needsRenewal()).toBe(false);
});
it('ordinary 403 does not expire access; 401 does without changing local owner', async () => {
  const { store, http, client } = setup();
  for (const status of [403, 401]) {
    const pending = firstValueFrom(client.get('/api/account/sessions')).catch((e) => e);
    http.expectOne('/api/account/sessions').flush({}, { status, statusText: 'Failure' });
    await pending;
    expect(store.needsRenewal()).toBe(status === 401);
    expect(store.localOwner()).toBe(owner);
  }
});
it('different account written by another tab fences requests and a late renewal response', async () => {
  const { store, local, http, client } = setup();
  const op = store.renew('password').catch((e) => e);
  await sent();
  const req = http.expectOne('/api/auth/renew');
  const foreign = { ...local.value()!, user: response(other).user, revision: crypto.randomUUID() };
  localStorage.setItem(key, JSON.stringify(foreign));
  window.dispatchEvent(new StorageEvent('storage', { key }));
  TestBed.tick();
  req.flush(response());
  expect(await op).toBeInstanceOf(Error);
  expect(store.localOwner()).toBe(owner);
  expect(readLocalProfile(key)?.user.id).toBe(other);
  expect(local.conflict()).toBe(true);
  await expect(firstValueFrom(client.get('/api/music/search'))).rejects.toBeInstanceOf(
    HttpErrorResponse,
  );
  http.expectNone('/api/music/search');
});
it('restores expired local identity after reload without API validation while offline', async () => {
  const { local } = setup();
  local.setMode('offline');
  local.mark('required');
  const saved = local.value();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([localModeInterceptor])),
      provideHttpClientTesting(),
      { provide: PROFILE_STORAGE_KEY, useValue: key },
    ],
  });
  const restored = TestBed.inject(SessionStore);
  expect(restored.local.value()).toEqual(saved);
  expect(await restored.load()).toBeNull();
  controller = TestBed.inject(HttpTestingController);
  expect(restored.localOwner()).toBe(owner);
  expect(restored.needsRenewal()).toBe(true);
});

it.each([0, 403, 429, 503])('validation failure %i is not expiry or a mode change', async status => {
  const { store, local, http } = setup();
  const pending = store.checkRemote();
  const req = http.expectOne('/api/auth/session');
  if (status === 0) req.error(new ProgressEvent('error'));
  else req.flush({}, {status, statusText:'Failure'});
  await pending;
  expect(store.needsRenewal()).toBe(false);
  expect(local.offline()).toBe(false);
  expect(store.remoteStatus()).toBe(status === 403 ? 'forbidden' : status === 429 ? 'throttled' : 'unreachable');
  expect(store.checking()).toBe(false);
});

it('keeps an initial connection failure at an access gate without choosing offline', async () => {
  const {local} = setup();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({providers:[provideRouter([]),provideHttpClient(withInterceptors([localModeInterceptor])),provideHttpClientTesting(),{provide:PROFILE_STORAGE_KEY,useValue:key}]});
  controller = TestBed.inject(HttpTestingController);
  const store=TestBed.inject(SessionStore), router=TestBed.inject(Router);
  const pending=TestBed.runInInjectionContext(()=>authGuard({} as ActivatedRouteSnapshot,{url:'/downloads'} as RouterStateSnapshot));
  controller.expectOne('/api/auth/session').error(new ProgressEvent('error'));
  expect(router.serializeUrl(await pending as import('@angular/router').UrlTree)).toBe('/access?returnUrl=%2Fdownloads');
  expect(store.local.offline()).toBe(false);
  expect(store.localOwner()).toBe(local.value()?.user.id);
  expect(store.needsRenewal()).toBe(false);
});

it('expired online identity opens a choice, whereas a previously chosen offline mode is restored', async () => {
  const {store,local}=setup(),router=TestBed.inject(Router);
  store.requireRenewal();
  const guard=()=>TestBed.runInInjectionContext(()=>authGuard({} as ActivatedRouteSnapshot,{url:'/downloads'} as RouterStateSnapshot));
  expect(router.serializeUrl(await guard() as import('@angular/router').UrlTree)).toContain('/access?');
  expect(local.offline()).toBe(false);
  local.setMode('offline');TestBed.tick();
  expect(router.serializeUrl(await guard() as import('@angular/router').UrlTree)).toBe('/local');
});

it('honors Retry-After before another manual validation', async()=>{
  const {store,http}=setup();
  const pending=store.checkRemote();
  http.expectOne('/api/auth/session').flush({}, {status:429,statusText:'Wait',headers:{'Retry-After':'120'}});
  await pending;
  expect(store.checkWaitSeconds()).toBeGreaterThan(0);
  expect(await store.checkRemote()).toBeNull();
  http.expectNone('/api/auth/session');
  expect(store.needsRenewal()).toBe(false);
});
