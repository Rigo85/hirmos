import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-accept-invitation',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './accept-invitation.component.html',
})
export class AcceptInvitationComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly routeToken = this.route.snapshot.queryParamMap.get('token');
  private readonly tokenStorageKey = 'hirmos.invitation-token';
  protected readonly token = this.routeToken ?? sessionStorage.getItem(this.tokenStorageKey);
  protected readonly submitting = signal(false);
  protected readonly completed = signal(false);
  protected readonly errorMessage = signal<string | null>(
    this.token ? null : 'El enlace no contiene una invitación válida.',
  );
  protected readonly form = new FormGroup({
    displayName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100)],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(12)],
    }),
    confirmPassword: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  public constructor() {
    if (this.routeToken) {
      sessionStorage.setItem(this.tokenStorageKey, this.routeToken);
      void this.router.navigate([], { replaceUrl: true, queryParams: {} });
    }
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.password !== value.confirmPassword || !this.token) {
      if (value.password !== value.confirmPassword) this.errorMessage.set('Las contraseñas no coinciden.');
      else if (this.form.invalid) this.errorMessage.set('Corrige los campos marcados antes de continuar.');
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      await firstValueFrom(this.http.post('/api/auth/invitations/accept', {
        token: this.token,
        displayName: value.displayName,
        password: value.password,
      }));
      sessionStorage.removeItem(this.tokenStorageKey);
      this.completed.set(true);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 400) {
        this.errorMessage.set('La invitación ya fue usada, expiró o no es válida.');
      } else if (error instanceof HttpErrorResponse && error.status === 429) {
        const seconds = Number(error.headers.get('retry-after'));
        this.errorMessage.set(Number.isFinite(seconds) && seconds > 0
          ? `Demasiados intentos. Vuelve a probar en ${Math.ceil(seconds / 60)} minutos.`
          : 'Demasiados intentos. Espera un momento antes de volver a probar.');
      } else {
        this.errorMessage.set('No pudimos crear tu cuenta. Inténtalo nuevamente.');
      }
    } finally {
      this.submitting.set(false);
    }
  }
}
