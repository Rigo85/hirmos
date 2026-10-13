import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AccountComponent, sessionBrowser } from './account.component';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  current: true,
  userAgent: 'Chrome/123 Linux',
  createdAt: '2026-10-01T10:00:00Z',
  lastSeenAt: '2026-10-01T11:00:00Z',
  expiresAt: '2026-10-31T10:00:00Z',
};
beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [AccountComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      {
        provide: SessionStore,
        useValue: {
          session: signal({ user: { displayName: 'Test', email: 'test@example.test' } }),
          closed: vi.fn(),requireRenewal:vi.fn(),
        },
      },
      { provide: PlaybackSyncService, useValue: { disconnect: vi.fn() } },
    ],
  });
});
afterEach(() => {
  TestBed.inject(HttpTestingController).verify();
});
async function setup() {
  const fixture = TestBed.createComponent(AccountComponent);
  fixture.detectChanges();
  TestBed.inject(HttpTestingController)
    .expectOne('/api/account/sessions?offset=0')
    .flush({ sessions: [item], hasMore: false });
  await fixture.whenStable();
  fixture.detectChanges();
  const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
  dialog.showModal = vi.fn();
  dialog.close = vi.fn();
  const button = (text: string) =>
    [...fixture.nativeElement.querySelectorAll('button')].find(
      (b: HTMLButtonElement) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  return { fixture, dialog, button, http: TestBed.inject(HttpTestingController) };
}
it('shows current session and asks for confirmation without changing playback', async () => {
  const { fixture, button, dialog, http } = await setup();
  expect(fixture.nativeElement.textContent).toContain('Esta sesión');
  button('Cerrar las demás').click();
  fixture.detectChanges();
  expect(dialog.showModal).toHaveBeenCalledOnce();
  expect(dialog.textContent).toContain('Esta sesión seguirá abierta');
  button('Cancelar').click();
  fixture.detectChanges();
  http.expectNone('/api/account/sessions/revoke');
  expect(TestBed.inject(PlaybackSyncService).disconnect).not.toHaveBeenCalled();
});
it('closes other sessions and refreshes without disconnecting this player', async () => {
  const { fixture, button, http } = await setup();
  button('Cerrar las demás').click();
  fixture.detectChanges();
  button('Cerrar las demás sesiones').click();
  const request = http.expectOne('/api/account/sessions/revoke');
  expect(request.request.body).toEqual({ scope: 'others' });
  request.flush({ revoked: 2 });
  await Promise.resolve();
  await Promise.resolve();
  http.expectOne('/api/account/sessions?offset=0').flush({ sessions: [item], hasMore: false });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Tu cola y tu historial se conservan');
  expect(TestBed.inject(PlaybackSyncService).disconnect).not.toHaveBeenCalled();
});
it('confirmed current close clears local auth and disconnects playback', async () => {
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const { fixture, button, http } = await setup();
  button('Salir aquí').click();
  fixture.detectChanges();
  button('Salir de esta sesión').click();
  const request = http.expectOne(`/api/account/sessions/${item.id}`);
  expect(request.request.method).toBe('DELETE');
  request.flush(null);
  await fixture.whenStable();
  expect(TestBed.inject(SessionStore).closed).toHaveBeenCalledOnce();
  expect(TestBed.inject(PlaybackSyncService).disconnect).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith(['/local']);
});
it('does not claim successful close after a network failure', async () => {
  const { fixture, button, http } = await setup();
  button('Cerrar las demás').click();
  fixture.detectChanges();
  button('Cerrar las demás sesiones').click();
  http
    .expectOne('/api/account/sessions/revoke')
    .flush({}, { status: 503, statusText: 'Unavailable' });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('No pudimos confirmar el cierre');
  expect(TestBed.inject(SessionStore).closed).not.toHaveBeenCalled();
});
it('does not pretend to distinguish Brave from Chromium using its user agent', () => {
  expect(sessionBrowser('Mozilla/5.0 Android Chrome/130.0')).toBe('Chrome / Chromium · Android');
  expect(sessionBrowser(null)).toBe('Navegador no identificado');
});
