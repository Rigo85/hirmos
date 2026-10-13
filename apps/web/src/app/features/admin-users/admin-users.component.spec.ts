import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminUsersComponent } from './admin-users.component';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';
const user = {
  id: 'synthetic',
  email: 'admin@example.test',
  displayName: 'Admin',
  role: 'admin',
  disabled: false,
  updatedAt: '2026-10-01T12:00:00.123456Z',
};
beforeEach(() =>
  TestBed.configureTestingModule({
    imports: [AdminUsersComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SessionStore, useValue: { session: signal({ user }), clear: vi.fn(),needsRenewal:signal(false),local:{offline:signal(false),conflict:signal(false)},remoteStatus:signal('available'),deviceConnection:signal('connected') } },
      { provide: PlaybackSyncService, useValue: { disconnect: vi.fn() } },
    ],
  }),
);
afterEach(() => TestBed.inject(HttpTestingController).verify());
async function setup() {
  const fixture = TestBed.createComponent(AdminUsersComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/admin/users?offset=0&q=').flush({ users: [user], hasMore: false });
  await fixture.whenStable();
  fixture.detectChanges();
  const dialog = fixture.nativeElement.querySelector('dialog');
  dialog.showModal = vi.fn();
  dialog.close = vi.fn();
  const button = (text: string) =>
    [...fixture.nativeElement.querySelectorAll('button')].find(
      (b: HTMLButtonElement) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  return { fixture, http, dialog, button };
}
it('requires confirmation and password, without optimistic permission changes', async () => {
  const { fixture, http, button, dialog } = await setup();
  dialog.showModal.mockImplementation(() => {
    expect(dialog.querySelector('#account-confirm-title')?.textContent).toContain('Editar acceso');
    expect(dialog.querySelector('.dialog-actions')?.textContent).toContain('Guardar acceso');
  });
  button('Editar acceso').click();
  fixture.detectChanges();
  expect(dialog.showModal).toHaveBeenCalledOnce();
  button('Guardar acceso').click();
  fixture.detectChanges();
  expect(dialog.textContent).toContain('Confirma tu contraseña actual');
  const input = fixture.nativeElement.querySelector('#admin-password');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toBe('admin-password-error');
  http.expectNone('/api/admin/users/synthetic');
  button('Cancelar').click();
  expect(dialog.close).toHaveBeenCalledOnce();
});

it('names the resend action and allows cancelling without issuing a request', async () => {
  const { fixture, http, button, dialog } = await setup();
  button('Invitaciones').click();
  http.expectOne('/api/admin/invitations?offset=0').flush({invitations:[{id:'pending', email:'pending@example.test', role:'user', expiresAt:'2026-10-03T00:00:00Z', expired:false}],hasMore:false});
  await fixture.whenStable(); fixture.detectChanges();
  button('Reenviar').click(); fixture.detectChanges();
  expect(dialog.textContent).toContain('El anterior dejará de funcionar');
  expect(button('Reenviar invitación').classList.contains('dialog-danger')).toBe(false);
  button('Cancelar').click(); http.expectNone('/api/admin/invitations/pending/resend');
});
it('keeps exact version and shows last-admin rejection inside the dialog', async () => {
  const { fixture, http, button, dialog } = await setup();
  button('Editar acceso').click();
  fixture.detectChanges();
  const input = fixture.nativeElement.querySelector('#admin-password');
  input.value = 'synthetic';
  input.dispatchEvent(new Event('input'));
  button('Guardar acceso').click();
  fixture.detectChanges();
  expect(dialog.querySelector('fieldset').disabled).toBe(true);
  const request = http.expectOne('/api/admin/users/synthetic');
  expect(request.request.method).toBe('PATCH');
  expect(request.request.body.expectedUpdatedAt).toBe(user.updatedAt);
  request.flush({ code: 'LAST_ADMIN' }, { status: 409, statusText: 'Conflict' });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(dialog.textContent).toContain('Debe quedar al menos un administrador activo');
  expect(dialog.close).not.toHaveBeenCalled();
  expect(input.value).toBe('');
  expect(TestBed.inject(PlaybackSyncService).disconnect).not.toHaveBeenCalled();
});
it('revokes an invitation only after explicit confirmation', async () => {
  const { fixture, http, button } = await setup();
  button('Invitaciones').click();
  http.expectOne('/api/admin/invitations?offset=0').flush({
    invitations: [
      {
        id: 'pending',
        email: 'new@example.test',
        role: 'user',
        expiresAt: '2026-10-02T12:00:00Z',
        expired: false,
      },
    ],
    hasMore: false,
  });
  await fixture.whenStable();
  fixture.detectChanges();
  button('Revocar').click();
  fixture.detectChanges();
  http.expectNone('/api/admin/invitations/pending');
  button('Revocar invitación').click();
  const request = http.expectOne('/api/admin/invitations/pending');
  expect(request.request.method).toBe('DELETE');
  request.flush(null);
  await Promise.resolve();
  await Promise.resolve();
  http.expectOne('/api/admin/invitations?offset=0').flush({ invitations: [], hasMore: false });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Invitación revocada');
});

it('does not mistake a failed query for an empty list and clears the error after retry', async () => {
  const { fixture, http, button } = await setup();
  button('Invitaciones').click();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Consultando invitaciones');
  expect(fixture.nativeElement.textContent).not.toContain('No hay invitaciones');
  http
    .expectOne('/api/admin/invitations?offset=0')
    .flush({}, { status: 503, statusText: 'Unavailable' });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('No pudimos actualizar esta consulta');
  expect(fixture.nativeElement.textContent).not.toContain('No hay invitaciones');
  button('Actualizar').click();
  http.expectOne('/api/admin/invitations?offset=0').flush({ invitations: [], hasMore: false });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).not.toContain('No pudimos actualizar');
  expect(fixture.nativeElement.textContent).toContain('No hay invitaciones');
});

it('blocks cancellation and a second submit during the mutation, then restores controls on failure', async () => {
  const { fixture, http, button, dialog } = await setup();
  button('Editar acceso').click();
  fixture.detectChanges();
  const input = fixture.nativeElement.querySelector('#admin-password');
  input.value = 'synthetic';
  input.dispatchEvent(new Event('input'));
  button('Guardar acceso').click();
  fixture.detectChanges();
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(button('Cancelar').disabled).toBe(true);
  button('Procesando…').click();
  http
    .expectOne('/api/admin/users/synthetic')
    .flush({}, { status: 503, statusText: 'Unavailable' });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(dialog.querySelector('fieldset').disabled).toBe(false);
  expect(button('Cancelar').disabled).toBe(false);
  expect(dialog.textContent).toContain('No pudimos confirmar el cambio');
});
