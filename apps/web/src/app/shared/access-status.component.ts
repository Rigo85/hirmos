import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionStore } from '../core/session.store';

/** Access/connectivity owns this notice. Track and transfer failures stay contextual. */
@Component({
  selector: 'app-access-status',
  imports: [RouterLink],
  template: `
    @if (issue(); as reason) {
      @if (dismissed() === reason) {
        <div class="compact"><button type="button" (click)="dismissed.set(null)"
          aria-expanded="false">{{ label() }} · Ver detalles</button></div>
      } @else {
        <section aria-label="Estado del acceso online">
          <p role="status">{{ message() }}</p>
          <div class="actions">
            @if (reason === 'required' && store.localOwner()) {
              <button type="button" class="primary" (click)="store.requestRenewal()">Renovar acceso</button>
            } @else if (reason !== 'conflict' && reason !== 'forbidden') {
              <button type="button" class="primary" (click)="retry()" [disabled]="store.checking() || store.busy() || store.checkWaitSeconds() > 0">
                {{ store.checking() ? 'Comprobando…' : 'Comprobar acceso' }}
              </button>
              @if (store.checkWaitSeconds(); as seconds) { <span role="timer" aria-live="off">Disponible en {{ seconds }} s</span> }
            }
            @if (store.localOwner()) { <a routerLink="/local">Ver descargas locales</a> }
            <button type="button" class="dismiss" (click)="dismissed.set(reason)" aria-label="Cerrar aviso de acceso">Cerrar</button>
          </div>
        </section>
      }
    }
  `,
  styles: `
    :host { display:block; }
    section { margin:12px 16px; padding:16px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--text); }
    p { margin:0 0 12px; line-height:1.5; }
    .actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; }
    button, a { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--text); font:inherit; cursor:pointer; text-decoration:none; }
    button:disabled { opacity:.6; cursor:wait; }
    .primary { background:var(--accent); color:#101216; border-color:var(--accent); font-weight:600; }
    .dismiss { margin-left:auto; }
    .compact { display:flex; justify-content:flex-end; padding:4px 16px; }
    .compact button { border:0; color:var(--muted); }
    @media(max-width:600px) { .actions > :not(.dismiss) { flex:1 1 auto; } }
  `,
})
export class AccessStatusComponent {
  protected readonly store = inject(SessionStore);
  protected readonly dismissed = signal<string | null>(null);
  protected readonly issue = computed(() => {
    if (this.store.local.offline()) return null;
    if (this.store.local.conflict()) return 'conflict';
    if (this.store.needsRenewal() || this.store.remoteStatus() === 'required') return 'required';
    const remote = this.store.remoteStatus();
    if (['unreachable', 'forbidden', 'throttled'].includes(remote)) return remote;
    return this.store.deviceConnection() === 'interrupted' ? 'connection' : null;
  });
  protected readonly label = computed(() => this.issue() === 'required' ? 'Acceso pendiente'
    : this.issue() === 'conflict' ? 'Cuenta diferente' : 'Conexión pendiente');
  protected readonly message = computed(() => {
    switch (this.issue()) {
      case 'required': return 'Renueva el acceso para utilizar las funciones online. Tus descargas locales se conservan.';
      case 'conflict': return 'La cuenta cambió en otra pestaña. No conectaremos este perfil con otra cuenta. Tus archivos locales se conservan.';
      case 'forbidden': return 'El servidor no permite esta operación. Renovar la sesión no cambia tus permisos.';
      case 'throttled': return 'El servidor pidió esperar antes de comprobar el acceso. Tus descargas locales se conservan.';
      case 'connection': return 'Se interrumpió la conexión del reproductor. Intentamos reconectar; esto no significa que tu sesión haya terminado.';
      default: return 'No pudimos comprobar el acceso a Hirmos. No lo trataremos como un cierre de sesión.';
    }
  });
  constructor() {
    // Dismissal belongs to the current cause, not to every reconnect attempt.
    effect(() => { if (!this.issue()) this.dismissed.set(null); });
  }
  protected async retry(): Promise<void> { await this.store.checkRemote(); }
}
