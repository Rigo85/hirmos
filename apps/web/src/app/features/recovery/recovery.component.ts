import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-recovery',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './recovery.component.html',
})
export class RecoveryComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly routeToken = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  private readonly tokenStorageKey = 'hirmos.recovery-token';
  protected readonly token = this.routeToken ?? sessionStorage.getItem(this.tokenStorageKey);
  protected readonly submitting = signal(false);
  protected readonly completed = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly requestForm = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
  });
  protected readonly resetForm = new FormGroup({
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

  protected async requestRecovery(): Promise<void> {
    this.requestForm.markAllAsTouched();
    if (this.requestForm.invalid || this.submitting()) return;
    await this.perform(async () => {
      await firstValueFrom(
        this.http.post('/api/auth/recovery/request', this.requestForm.getRawValue()),
      );
      this.completed.set(true);
    });
  }

  protected async resetPassword(): Promise<void> {
    this.resetForm.markAllAsTouched();
    const value = this.resetForm.getRawValue();
    if (!this.token) {
      this.errorMessage.set('El enlace no contiene un token de recuperación válido.');
      return;
    }
    if (this.resetForm.invalid) {
      this.errorMessage.set('Corrige los campos marcados antes de continuar.');
      return;
    }
    if (value.password !== value.confirmPassword) {
      this.errorMessage.set('Las contraseñas no coinciden.');
      return;
    }
    await this.perform(async () => {
      await firstValueFrom(
        this.http.post('/api/auth/recovery/complete', {
          token: this.token,
          password: value.password,
        }),
      );
      sessionStorage.removeItem(this.tokenStorageKey);
      this.completed.set(true);
    });
  }

  private async perform(action: () => Promise<void>): Promise<void> {
    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      await action();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 400) {
        this.errorMessage.set('El enlace ya fue usado, expiró o no es válido.');
      } else if (error instanceof HttpErrorResponse && error.status === 429) {
        const seconds = Number(error.headers.get('retry-after'));
        this.errorMessage.set(Number.isFinite(seconds) && seconds > 0
          ? `Demasiados intentos. Vuelve a probar en ${formatWait(seconds)}.`
          : 'Demasiados intentos. Espera un momento antes de volver a probar.');
      } else {
        this.errorMessage.set('No pudimos completar la solicitud. Inténtalo nuevamente.');
      }
    } finally {
      this.submitting.set(false);
    }
  }
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} segundos`;
  return `${Math.ceil(seconds / 60)} minutos`;
}
