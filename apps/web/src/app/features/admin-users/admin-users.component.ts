import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import type { ManagedUser, ManagedInvitation, AccountAuditEntry } from '@hirmos/contracts';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AccessStatusComponent } from '../../shared/access-status.component';

type Tab = 'users' | 'invitations' | 'events';
type Action =
  | { kind: 'user'; user: ManagedUser }
  | { kind: 'resend' | 'revoke'; invitation: ManagedInvitation };

@Component({
  selector: 'app-admin-users',
  imports: [AccessStatusComponent, ReactiveFormsModule, RouterLink, DatePipe],
  templateUrl: './admin-users.component.html',
  styleUrl: './admin-users.component.scss',
})
export class AdminUsersComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly view = inject(ChangeDetectorRef);
  private opener: HTMLElement | null = null;
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly store = inject(SessionStore);
  private readonly playback = inject(PlaybackSyncService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('confirmation');
  protected readonly tab = signal<Tab>('users');
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly submitting = signal(false);
  protected readonly users = signal<ManagedUser[]>([]);
  protected readonly invitations = signal<ManagedInvitation[]>([]);
  protected readonly events = signal<AccountAuditEntry[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly offset = signal(0);
  protected readonly action = signal<Action | null>(null);
  protected readonly modalError = signal('');
  protected readonly search = new FormControl('', { nonNullable: true });
  protected readonly edit = new FormGroup({
    role: new FormControl<'user' | 'admin'>('user', { nonNullable: true }),
    disabled: new FormControl(false, { nonNullable: true }),
    currentPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(1024)],
    }),
  });
  protected readonly message = signal<{ kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    role: new FormControl<'user' | 'admin'>('user', { nonNullable: true }),
  });

  constructor() {
    void this.load();
  }
  protected async switchTab(tab: Tab): Promise<void> {
    if (this.loading() || this.submitting()) return;
    this.tab.set(tab);
    this.loaded.set(false);
    this.users.set([]);
    this.invitations.set([]);
    this.events.set([]);
    this.hasMore.set(false);
    this.offset.set(0);
    this.message.set(null);
    await this.load();
  }
  protected async load(offset = this.offset()): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.loadError.set('');
    try {
      const tab = this.tab();
      const result = await firstValueFrom(
        this.http
          .get<{
            users?: ManagedUser[];
            invitations?: ManagedInvitation[];
            events?: AccountAuditEntry[];
            hasMore: boolean;
          }>(`/api/admin/${tab === 'events' ? 'account-events' : tab}`, {
            params: {
              offset,
              ...(tab === 'users' ? { q: this.search.value.trim().slice(0, 100) } : {}),
            },
          })
          .pipe(timeout(15_000)),
      );
      this.users.set(result.users ?? []);
      this.invitations.set(result.invitations ?? []);
      this.events.set(result.events ?? []);
      this.hasMore.set(result.hasMore);
      this.offset.set(offset);
      this.loaded.set(true);
    } catch {
      this.loadError.set(
        'No pudimos actualizar esta consulta. Pulsa Actualizar para reintentar; los datos anteriores, si aparecen, pueden estar desactualizados.',
      );
    } finally {
      this.loading.set(false);
    }
  }
  protected ask(action: Action): void {
    if (this.submitting() || this.loading()) return;
    this.opener = this.host.nativeElement.ownerDocument.activeElement as HTMLElement | null;
    this.action.set(action);
    this.modalError.set('');
    this.edit.reset(
      action.kind === 'user'
        ? { role: action.user.role, disabled: action.user.disabled, currentPassword: '' }
        : {},
    );
    // Render the accessible name and controls before native dialog moves focus.
    this.view.detectChanges();
    this.dialog().nativeElement.showModal();
    const modal = this.dialog().nativeElement;
    if (modal.scrollHeight > modal.clientHeight + 1) {
      modal.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      modal.scrollTop = 0;
    }
  }
  protected cancel(event?: Event): void {
    if (this.submitting()) {
      event?.preventDefault();
      return;
    }
    this.dialog().nativeElement.close();
    this.action.set(null);
    this.edit.controls.currentPassword.reset();
  }
  protected async confirm(): Promise<void> {
    const action = this.action();
    if (!action || this.submitting()) return;
    if (action.kind === 'user') {
      this.edit.markAllAsTouched();
      if (this.edit.invalid) {
        this.dialog().nativeElement.querySelector<HTMLInputElement>('#admin-password')?.focus();
        return;
      }
    }
    this.submitting.set(true);
    this.modalError.set('');
    this.message.set(null);
    try {
      if (action.kind === 'user') {
        await firstValueFrom(
          this.http
            .patch(`/api/admin/users/${action.user.id}`, {
              ...this.edit.getRawValue(),
              expectedUpdatedAt: action.user.updatedAt,
            })
            .pipe(timeout(15_000)),
        );
      } else {
        const url = `/api/admin/invitations/${action.invitation.id}`;
        await firstValueFrom(
          (action.kind === 'revoke'
            ? this.http.delete(url)
            : this.http.post(`${url}/resend`, {})
          ).pipe(timeout(15_000)),
        );
      }
      this.dialog().nativeElement.close();
      this.action.set(null);
      const changedSelf =
        action.kind === 'user' &&
        action.user.id === this.store.session()?.user.id &&
        (action.user.role !== this.edit.controls.role.value ||
          action.user.disabled !== this.edit.controls.disabled.value);
      if (changedSelf) {
        this.playback.disconnect();
        this.store.clear();
        await this.router.navigate(['/local']);
        return;
      }
      this.message.set({
        kind: 'success',
        text:
          action.kind === 'user'
            ? 'Acceso actualizado. Si cambió el rol o estado, sus sesiones se cerraron.'
            : action.kind === 'resend'
              ? 'Nuevo enlace en cola de envío. El enlace anterior ya no es válido.'
              : 'Invitación revocada. Su enlace ya no es válido.',
      });
      await this.load();
    } catch (error) {
      this.modalError.set(this.failure(error));
    } finally {
      this.edit.controls.currentPassword.reset();
      this.submitting.set(false);
      if (this.host.nativeElement.isConnected) {
        this.view.detectChanges();
        if (!this.action()) {
          const target = this.opener?.isConnected
            ? this.opener
            : this.host.nativeElement.querySelector<HTMLElement>('h1');
          target?.focus();
        } else this.dialog().nativeElement.querySelector<HTMLElement>('[role="alert"]')?.focus();
      }
    }
  }
  private failure(error: unknown): string {
    const messages: Record<string, string> = {
      LAST_ADMIN: 'Debe quedar al menos un administrador activo.',
      ACCOUNT_CONFLICT:
        'La cuenta cambió. Cierra este diálogo y actualiza antes de editar nuevamente.',
      REAUTH_REQUIRED: 'Comprueba tu contraseña actual. Si la sesión cambió, vuelve a entrar.',
      ACCOUNT_NOT_FOUND: 'La cuenta o invitación ya no está disponible. Actualiza la lista.',
      FORBIDDEN: 'Ya no tienes permiso para esta acción.',
    };
    return error instanceof HttpErrorResponse && error.status === 429
      ? 'Demasiados intentos. Espera antes de reintentar.'
      : (error instanceof HttpErrorResponse && messages[error.error?.code]) ||
          'No pudimos confirmar el cambio. Cierra y actualiza antes de reintentar.';
  }
  protected eventLabel(type: string): string {
    const labels: Record<string, string> = {
      'password.changed': 'Contraseña cambiada',
      'account.updated': 'Rol o estado actualizado',
      'session.revoked': 'Sesión cerrada',
      'invitation.queued': 'Invitación puesta en cola',
      'invitation.revoked': 'Invitación revocada',
      'invitation.accepted': 'Invitación aceptada',
      'password.recovery.completed': 'Contraseña recuperada',
    };
    return labels[type] ?? type;
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.submitting()) return;
    if (this.form.invalid) {
      this.host.nativeElement.querySelector<HTMLInputElement>('#invite-email')?.focus();
      return;
    }
    this.submitting.set(true);
    this.message.set(null);
    try {
      await firstValueFrom(
        this.http.post('/api/admin/invitations', this.form.getRawValue()).pipe(timeout(15_000)),
      );
      this.message.set({ kind: 'success', text: 'Invitación en cola para envío.' });
      this.form.controls.email.reset('');
      await this.load(0);
    } catch (error) {
      this.message.set({
        kind: 'error',
        text:
          error instanceof HttpErrorResponse && error.status === 409
            ? 'Ese correo ya tiene una cuenta.'
            : 'No pudimos crear la invitación.',
      });
    } finally {
      this.submitting.set(false);
    }
  }
}
