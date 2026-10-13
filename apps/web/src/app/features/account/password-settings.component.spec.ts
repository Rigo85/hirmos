import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PasswordSettingsComponent } from './password-settings.component';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';

beforeEach(() =>
  TestBed.configureTestingModule({
    imports: [PasswordSettingsComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: SessionStore,
        useValue: { session: signal({ user: { email: 'synthetic@example.test' } }),acceptAuthenticatedSession(result: any){this.session.set(result);} },
      },
      { provide: PlaybackSyncService, useValue: { disconnect: vi.fn(), connect: vi.fn() } },
    ],
  }),
);
afterEach(() => TestBed.inject(HttpTestingController).verify());
function setup() {
  const fixture = TestBed.createComponent(PasswordSettingsComponent);
  fixture.detectChanges();
  const fill = (id: string, value: string) => {
    const input = fixture.nativeElement.querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
  };
  const submit = () => {
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  };
  return { fixture, fill, submit, http: TestBed.inject(HttpTestingController) };
}
it('explains short and mismatching passwords before making any request', () => {
  const { fixture, fill, submit, http } = setup();
  fill('password-current', 'synthetic');
  fill('password-new', 'short');
  fill('password-repeat', 'short');
  submit();
  expect(fixture.nativeElement.textContent).toContain(
    'La nueva contraseña debe tener entre 12 y 1024 caracteres',
  );
  expect(fixture.nativeElement.querySelector('#password-new').getAttribute('aria-invalid')).toBe(
    'true',
  );
  expect(
    fixture.nativeElement.querySelector('#password-new').getAttribute('aria-describedby'),
  ).toContain('password-new-error');
  fill('password-new', 'long-enough-password');
  submit();
  expect(fixture.nativeElement.textContent).toContain('no coinciden');
  http.expectNone('/api/account/password');
});
it('rotates local auth, reconnects only after response and refreshes sessions', async () => {
  const { fixture, fill, submit, http } = setup();
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  fill('password-current', 'synthetic-old');
  fill('password-new', 'synthetic-new');
  fill('password-repeat', 'synthetic-new');
  submit();
  submit();
  expect(fixture.nativeElement.querySelector('fieldset').disabled).toBe(true);
  const request = http.expectOne('/api/account/password');
  expect(request.request.body).toEqual({
    currentPassword: 'synthetic-old',
    newPassword: 'synthetic-new',
  });
  expect(TestBed.inject(PlaybackSyncService).disconnect).not.toHaveBeenCalled();
  const result = { user: { email: 'synthetic@example.test' }, expiresAt: '2026-11-01T00:00:00Z' };
  request.flush(result);
  await fixture.whenStable();
  fixture.detectChanges();
  expect(TestBed.inject(SessionStore).session()).toEqual(result);
  expect(changed).toHaveBeenCalledOnce();
  expect(TestBed.inject(PlaybackSyncService).connect).toHaveBeenCalledOnce();
  expect(fixture.nativeElement.querySelector('#password-current').value).toBe('');
});
it('does not retry or claim success on an ambiguous failure', async () => {
  const { fixture, fill, submit, http } = setup();
  fill('password-current', 'synthetic-old');
  fill('password-new', 'synthetic-new');
  fill('password-repeat', 'synthetic-new');
  submit();
  http.expectOne('/api/account/password').flush({}, { status: 503, statusText: 'Unavailable' });
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('No pudimos confirmar el cambio');
  expect(TestBed.inject(PlaybackSyncService).connect).not.toHaveBeenCalled();
  expect(fixture.nativeElement.querySelector('#password-current').value).toBe('');
});
