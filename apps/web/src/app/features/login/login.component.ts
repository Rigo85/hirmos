import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SessionStore } from '../../core/session.store';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly sessionStore = inject(SessionStore);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly passwordVisible = signal(false);

  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.submitting()) return;

    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      await this.sessionStore.login(this.form.getRawValue());
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      // A successful login starts a fresh runtime so Socket.IO and the
      // per-user player identity cannot leak across SPA sessions.
      window.location.assign(isSafeReturnUrl(returnUrl) ? returnUrl : '/');
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'No pudimos iniciar sesión.',
      );
    } finally {
      this.submitting.set(false);
    }
  }
}

function isSafeReturnUrl(value: string | null): value is string {
  return Boolean(value?.startsWith('/') && !value.startsWith('//'));
}
