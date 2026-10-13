import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, inject, output, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom, timeout } from 'rxjs';
import type { SessionResponse } from '@hirmos/contracts';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';

@Component({
  selector: 'app-password-settings',
  imports: [ReactiveFormsModule],
  template: ` <section class="account-ui" aria-labelledby="password-title">
    <h2 id="password-title">Cambiar contraseña</h2>
    <p class="password-help" id="password-impact">
      Renovaremos esta sesión y cerraremos las demás. Tu cola se conserva; puede ser necesario
      volver a pulsar Play.
    </p>
    <form
      [formGroup]="form"
      (ngSubmit)="save()"
      aria-describedby="password-impact"
      [attr.aria-busy]="busy()"
    >
      <fieldset class="form-fields" [disabled]="busy()" aria-label="Cambiar contraseña">
        <input
          type="text"
          autocomplete="username"
          [value]="store.session()?.user?.email || ''"
          hidden
        />
        <div class="form-field">
          <label for="password-current">Contraseña actual</label>
          <input
            id="password-current"
            type="password"
            autocomplete="current-password"
            formControlName="currentPassword"
            maxlength="1024"
            [attr.aria-invalid]="invalid('currentPassword')"
            [attr.aria-describedby]="invalid('currentPassword') ? 'password-current-error' : null"
          />
          @if (invalid('currentPassword')) {
            <p id="password-current-error" class="form-error" role="alert">
              Escribe tu contraseña actual.
            </p>
          }
        </div>
        <div class="form-field">
          <label for="password-new">Nueva contraseña</label>
          <input
            id="password-new"
            type="password"
            autocomplete="new-password"
            formControlName="newPassword"
            maxlength="1024"
            [attr.aria-invalid]="invalid('newPassword')"
            [attr.aria-describedby]="
              invalid('newPassword') ? 'password-rules password-new-error' : 'password-rules'
            "
          />
          <small id="password-rules">Usa al menos 12 caracteres.</small>
          @if (invalid('newPassword')) {
            <p id="password-new-error" class="form-error" role="alert">
              La nueva contraseña debe tener entre 12 y 1024 caracteres.
            </p>
          }
        </div>
        <div class="form-field">
          <label for="password-repeat">Repite la nueva contraseña</label>
          <input
            id="password-repeat"
            type="password"
            autocomplete="new-password"
            formControlName="repeat"
            maxlength="1024"
            [attr.aria-invalid]="
              form.controls.repeat.touched && (form.controls.repeat.invalid || mismatch())
            "
            [attr.aria-describedby]="
              form.controls.repeat.touched && (form.controls.repeat.invalid || mismatch())
                ? 'password-repeat-error'
                : null
            "
          />
          @if (form.controls.repeat.touched && (form.controls.repeat.invalid || mismatch())) {
            <p id="password-repeat-error" class="form-error" role="alert">
              {{
                form.controls.repeat.invalid
                  ? 'Repite la nueva contraseña.'
                  : 'Las contraseñas nuevas no coinciden.'
              }}
            </p>
          }
        </div>
      </fieldset>
      @if (error()) {
        <p class="form-error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="success-message" role="status">{{ notice() }}</p>
      }
      <button class="primary-button primary-button--compact" [disabled]="busy()">
        {{ busy() ? 'Actualizando…' : 'Cambiar contraseña' }}
      </button>
    </form>
  </section>`,
  styles: `
    :host {
      display: block;
      margin-top: 2rem;
    }
    section {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.5rem;
    }
    h2 {
      margin: 0 0 0.75rem;
    }
    .password-help {
      color: var(--muted);
      line-height: 1.6;
      max-width: 70ch;
    }
    form {
      display: grid;
      gap: 0.65rem;
      max-width: 34rem;
      margin-top: 1.5rem;
    }
    input {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      min-height: 48px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--text);
      background: var(--surface);
    }
    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    button {
      margin-top: 0.75rem;
      white-space: normal;
      text-align: center;
      height: auto;
      min-height: 48px;
      justify-self: start;
      padding: 12px 20px;
    }
    @media (max-width: 480px) {
      section {
        padding: 20px;
      }
      button {
        width: 100%;
      }
    }
    small {
      color: var(--muted);
    }
  `,
})
export class PasswordSettingsComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly http = inject(HttpClient);
  private readonly playback = inject(PlaybackSyncService);
  protected readonly store = inject(SessionStore);
  readonly changed = output<void>();
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly form = new FormGroup({
    currentPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(1024)],
    }),
    newPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(12), Validators.maxLength(1024)],
    }),
    repeat: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
  protected mismatch(): boolean {
    return this.form.controls.newPassword.value !== this.form.controls.repeat.value;
  }
  protected invalid(name: 'currentPassword' | 'newPassword'): boolean {
    return this.form.controls[name].touched && this.form.controls[name].invalid;
  }
  protected async save(): Promise<void> {
    if (this.busy()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid || this.mismatch()) {
      const id = this.form.controls.currentPassword.invalid
        ? 'password-current'
        : this.form.controls.newPassword.invalid
          ? 'password-new'
          : 'password-repeat';
      this.host.nativeElement.querySelector<HTMLInputElement>(`#${id}`)?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    const { currentPassword, newPassword } = this.form.getRawValue();
    try {
      const result = await firstValueFrom(
        this.http
          .post<SessionResponse>('/api/account/password', { currentPassword, newPassword })
          .pipe(timeout(15_000)),
      );
      this.store.acceptAuthenticatedSession(result);
      this.form.reset();
      this.playback.disconnect();
      this.playback.connect();
      this.notice.set(
        'Contraseña actualizada. Las demás sesiones están cerradas. Si el audio se pausó, pulsa Play.',
      );
      this.changed.emit();
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 403
          ? 'La contraseña actual no es válida o esta sesión cambió. Compruébala antes de reintentar.'
          : error instanceof HttpErrorResponse && error.status === 429
            ? 'Demasiados intentos. Espera unos minutos antes de volver a intentar.'
            : 'No pudimos confirmar el cambio. Prueba iniciar sesión con la contraseña nueva antes de repetirlo.',
      );
    } finally {
      this.form.controls.currentPassword.reset();
      this.busy.set(false);
    }
  }
}
