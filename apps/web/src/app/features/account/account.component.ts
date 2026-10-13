import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import type { AccountSession, AccountSessionsResponse } from '@hirmos/contracts';
import { SessionStore } from '../../core/session.store';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';
import { PasswordSettingsComponent } from './password-settings.component';

type CloseAction = { scope: 'others' | 'all' } | { session: AccountSession };

export function sessionBrowser(agent: string | null): string {
  if (!agent) return 'Navegador no identificado';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome / Chromium'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Navegador';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} · ${system}` : browser;
}

@Component({
  selector: 'app-account',
  imports: [DatePipe, AppIconComponent, PasswordSettingsComponent],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
})
export class AccountComponent {
  private readonly view = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private opener: HTMLElement | null = null;
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly playback = inject(PlaybackSyncService);
  protected readonly store = inject(SessionStore);
  private readonly confirmation = viewChild.required<ElementRef<HTMLDialogElement>>('confirmation');
  protected readonly sessions = signal<AccountSession[]>([]);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly pending = signal<CloseAction | null>(null);
  protected readonly browser = sessionBrowser;

  constructor() {
    void this.load();
  }

  protected async load(more = false): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(
        this.http
          .get<AccountSessionsResponse>('/api/account/sessions', {
            params: { offset: more ? this.sessions().length : 0 },
          })
          .pipe(timeout(15_000)),
      );
      this.sessions.set(
        more
          ? [...new Map([...this.sessions(), ...result.sessions].map((s) => [s.id, s])).values()]
          : result.sessions,
      );
      this.hasMore.set(result.hasMore);
      this.loaded.set(true);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.expired();
      else this.error.set('No pudimos consultar tus sesiones. Puedes volver a intentar.');
    } finally {
      this.loading.set(false);
    }
  }

  protected ask(action: CloseAction): void {
    if (this.busy() || this.loading()) return;
    this.opener = this.host.nativeElement.ownerDocument.activeElement as HTMLElement | null;
    this.pending.set(action);
    this.view.detectChanges();
    this.confirmation().nativeElement.showModal();
    const modal = this.confirmation().nativeElement;
    if (modal.scrollHeight > modal.clientHeight + 1) {
      modal.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      modal.scrollTop = 0;
    }
  }

  protected description(): string {
    const action = this.pending();
    if (!action) return '';
    if ('scope' in action)
      return action.scope === 'all'
        ? 'Cerrarás el acceso online aquí y en los demás navegadores. Los perfiles y archivos locales se conservan.'
        : 'Los demás navegadores tendrán que iniciar sesión nuevamente. Esta sesión seguirá abierta.';
    return action.session.current
      ? 'Cerrarás el acceso online en este navegador, incluidas sus otras pestañas. Las descargas locales se conservan.'
      : `Cerrarás la sesión de ${sessionBrowser(action.session.userAgent)}. Si reproduce audio, se detendrá al recibir el cierre.`;
  }

  protected confirmationLabel(): string {
    const action = this.pending();
    if (!action) return 'Cerrar sesión';
    return 'scope' in action
      ? action.scope === 'all'
        ? 'Cerrar todas las sesiones'
        : 'Cerrar las demás sesiones'
      : action.session.current
        ? 'Salir de esta sesión'
        : 'Cerrar sesión';
  }

  protected cancel(event?: Event): void {
    if (this.busy()) {
      event?.preventDefault();
      return;
    }
    this.confirmation().nativeElement.close();
    this.pending.set(null);
  }

  protected async confirm(): Promise<void> {
    const action = this.pending();
    if (!action || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      let count = 1;
      if ('session' in action)
        await firstValueFrom(
          this.http.delete(`/api/account/sessions/${action.session.id}`).pipe(timeout(15_000)),
        );
      else
        count = (
          await firstValueFrom(
            this.http
              .post<{ revoked: number }>('/api/account/sessions/revoke', { scope: action.scope })
              .pipe(timeout(15_000)),
          )
        ).revoked;
      this.confirmation().nativeElement.close();
      this.pending.set(null);
      if ('session' in action ? action.session.current : action.scope === 'all') await this.leave();
      else {
        this.notice.set(
          count === 0
            ? 'No había otras sesiones abiertas. Esta sesión sigue activa.'
            : `${count === 1 ? 'Sesión cerrada' : `${count} sesiones cerradas`}. Tu cola y tu historial se conservan.`,
        );
        await this.load();
      }
    } catch (error) {
      this.confirmation().nativeElement.close();
      this.pending.set(null);
      if (error instanceof HttpErrorResponse && error.status === 401) this.expired();
      else
        this.error.set(
          'No pudimos confirmar el cierre. Actualiza las sesiones antes de reintentar.',
        );
    } finally {
      this.busy.set(false);
      if (this.host.nativeElement.isConnected) {
        this.view.detectChanges();
        (this.opener?.isConnected
          ? this.opener
          : this.host.nativeElement.querySelector<HTMLElement>('h1')
        )?.focus();
      }
    }
  }

  private async leave(): Promise<void> {
    this.playback.disconnect();
    this.store.closed();
    await this.router.navigate(['/local']);
  }
  private expired():void {
    this.store.requireRenewal();
    this.error.set('El acceso online necesita renovarse. Puedes hacerlo sin salir de esta pantalla.');
  }
}
