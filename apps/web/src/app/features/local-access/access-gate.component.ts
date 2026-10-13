import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SessionStore } from '../../core/session.store';
import { AccessStatusComponent } from '../../shared/access-status.component';

/** A failed initial validation cannot mount authenticated screens or choose a playback mode. */
@Component({
  selector: 'app-access-gate',
  imports: [AccessStatusComponent, RouterLink],
  template: `
    <main>
      <a routerLink="/">Hirmos</a>
      <h1>Acceso online</h1>
      <p>No cambiamos tu modo ni tus descargas. Puedes comprobar el acceso o abrir el espacio local.</p>
      <app-access-status />
      @if (store.local.offline()) {
        <a class="outline-button" routerLink="/local">Volver al espacio local</a>
      } @else if (store.canUseRemote()) {
        <p role="status">Acceso confirmado.</p><a class="outline-button" [routerLink]="destination">Continuar online</a>
      } @else if (store.remoteStatus() === 'unknown') {
        <button class="outline-button" (click)="store.checkRemote()" [disabled]="store.checking()">Comprobar acceso</button>
      }
      @if (!store.localOwner()) { <a routerLink="/login">Iniciar sesión</a> }
    </main>
  `,
  styles: `main { max-width:760px; margin:10vh auto; padding:24px; color:var(--text); } p { line-height:1.6; } a { color:var(--accent); }`,
})
export class AccessGateComponent {
  protected readonly store = inject(SessionStore);
  private readonly requested = inject(ActivatedRoute).snapshot.queryParamMap.get('returnUrl');
  protected readonly destination = this.requested?.startsWith('/') && !this.requested.startsWith('//')
    && !/^\/(access|login|local)([/?#]|$)/.test(this.requested) ? this.requested : '/';
}
