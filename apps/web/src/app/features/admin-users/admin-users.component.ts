import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-admin-users',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './admin-users.component.html',
})
export class AdminUsersComponent {
  private readonly http = inject(HttpClient);
  protected readonly submitting = signal(false);
  protected readonly message = signal<{ kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    role: new FormControl<'user' | 'admin'>('user', { nonNullable: true }),
  });

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.submitting()) return;
    this.submitting.set(true);
    this.message.set(null);
    try {
      await firstValueFrom(this.http.post('/api/admin/invitations', this.form.getRawValue()));
      this.message.set({ kind: 'success', text: 'Invitación en cola para envío.' });
      this.form.controls.email.reset('');
    } catch (error) {
      this.message.set({
        kind: 'error',
        text: error instanceof HttpErrorResponse && error.status === 409
          ? 'Ese correo ya tiene una cuenta.'
          : 'No pudimos crear la invitación.',
      });
    } finally {
      this.submitting.set(false);
    }
  }
}
