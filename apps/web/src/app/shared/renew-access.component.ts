import {
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SessionStore } from '../core/session.store';
let nextDialogId = 0;

@Component({
  selector: 'app-renew-access',
  imports: [ReactiveFormsModule],
  template: `
    <dialog
      #dialog
      class="account-dialog"
      [attr.aria-labelledby]="id + '-title'"
      [attr.aria-describedby]="id + '-description'"
      (cancel)="close($event)"
    >
      <h2 [id]="id + '-title'">Renovar acceso online</h2>
      <p [id]="id + '-description'">
        No cambia tu modo ni tu cola. Puedes cerrar este formulario y continuar con tus descargas.
      </p>
      <form [formGroup]="form" (ngSubmit)="submit()">
        <label [for]="id + '-email'">Cuenta de este perfil</label>
        <input
          [id]="id + '-email'"
          type="email"
          autocomplete="username"
          [value]="store.local.value()?.user?.email ?? ''"
          readonly
        />
        <label [for]="id + '-password'">Contraseña</label>
        <input
          [id]="id + '-password'"
          type="password"
          autocomplete="current-password"
          formControlName="password"
          [attr.aria-invalid]="form.controls.password.touched && form.controls.password.invalid"
        />
        @if (form.controls.password.touched && form.controls.password.invalid) {
          <p class="field-error">Introduce tu contraseña.</p>
        }
        @if (error()) {
          <p role="alert" class="field-error">{{ error() }}</p>
        }
        <footer class="dialog-actions">
          <button type="button" class="outline-button" (click)="close()">Ahora no</button>
          <button class="primary-button" type="submit" [disabled]="store.busy()">
            {{ store.busy() ? 'Comprobando…' : 'Renovar acceso' }}
          </button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    :host {
      display: contents;
    }
    .account-dialog label {
      display: block;
      margin: 16px 0 6px;
    }
    .account-dialog input {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
    }
    .account-dialog p {
      line-height: 1.5;
    }
    .dialog-actions {
      margin-top: 24px;
    }
  `,
})
export class RenewAccessComponent {
  protected readonly id = 'renew-access-' + ++nextDialogId;
  protected readonly store = inject(SessionStore);
  protected readonly error = signal('');
  protected readonly form = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(1024)],
    }),
  });
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private opener: HTMLElement | null = null;
  private destroyed = false;
  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;
      if (this.store.renewalRequested() && !element.open) {
        this.error.set('');
        this.opener = document.activeElement as HTMLElement | null;
        element.showModal();
        element.querySelector<HTMLInputElement>('input[type="password"]')?.focus();
      } else if (!this.store.renewalRequested() && element.open) {
        element.close();
        this.form.reset();
        this.opener?.focus();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.form.reset();
    });
  }
  protected close(event?: Event): void {
    event?.preventDefault();
    this.form.reset();
    this.error.set('');
    this.store.dismissRenewal();
  }
  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.store.busy()) return;
    this.error.set('');
    const password = this.form.controls.password.value;
    this.form.reset();
    try {
      await this.store.renew(password);
    } catch (error) {
      if (!this.destroyed && this.store.renewalRequested())
        this.error.set(error instanceof Error ? error.message : 'No pudimos renovar el acceso.');
    }
  }
}
