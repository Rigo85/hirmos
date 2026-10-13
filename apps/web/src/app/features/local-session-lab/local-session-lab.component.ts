import {
  HttpBackend,
  HttpClient,
  HttpErrorResponse,
  HttpResponse,
  type HttpEvent,
  type HttpRequest,
} from '@angular/common/http';
import { Component, DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import type { SessionResponse } from '@hirmos/contracts';
import { LocalProfileStore, PROFILE_STORAGE_KEY } from '../../core/local-profile.store';
import { SessionStore } from '../../core/session.store';
import { RenewAccessComponent } from '../../shared/renew-access.component';
import { AccessStatusComponent } from '../../shared/access-status.component';

const session = (): SessionResponse => ({
  user: {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'local-audio@example.test',
    displayName: 'Audio sintético',
    role: 'user',
  },
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
@Injectable()
class SyntheticAuth extends HttpBackend {
  readonly requests = signal(0);
  readonly status = signal(200);
  override handle(request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    this.requests.update((n) => n + 1);
    return new Observable((subscriber) => {
      const timer = setTimeout(() => {
        const status = this.status();
        if (!['/api/auth/session', '/api/auth/renew', '/api/auth/logout'].includes(request.url)) {
          subscriber.error(
            new HttpErrorResponse({ status: 400, statusText: 'Unexpected synthetic request' }),
          );
          return;
        }
        if (status !== 200) {
          subscriber.error(new HttpErrorResponse({ status, statusText: 'Fallo sintético' }));
          return;
        }
        subscriber.next(
          new HttpResponse({
            status: request.url.endsWith('/logout') ? 204 : 200,
            body: request.url.endsWith('/logout') ? null : session(),
          }),
        );
        subscriber.complete();
      }, 1000);
      return () => clearTimeout(timer);
    });
  }
}
@Component({
  selector: 'app-local-session-lab',
  imports: [RenewAccessComponent, AccessStatusComponent],
  providers: [
    LocalProfileStore,
    SessionStore,
    SyntheticAuth,
    { provide: PROFILE_STORAGE_KEY, useValue: 'hirmos.local-session-lab.v1' },
    { provide: HttpClient, useFactory: () => new HttpClient(inject(SyntheticAuth)) },
  ],
  template: `
    <main class="account-ui">
      <p class="eyebrow">LABORATORIO LOCAL · SIN SERVIDOR NI COOKIES REALES</p>
      <h1>Continuidad durante la renovación</h1>
      <app-access-status />
      <p>
        Audio sintético silencioso de un minuto, repetido en bucle. Los controles de acceso usan el
        código real con respuestas simuladas; no tocan tu cuenta, archivos ni cola.
      </p>
      <audio
        controls
        loop
        [src]="audioUrl"
        (timeupdate)="seconds.set($any($event.target).currentTime)"
        (play)="playing.set(true)"
        (pause)="playing.set(false)"
      ></audio>
      <p role="status">
        Audio: {{ playing() ? 'reproduciendo' : 'en pausa' }} · {{ seconds().toFixed(1) }} s
      </p>
      <p>
        Modo: {{ store.local.offline() ? 'offline' : 'online' }} · Acceso:
        {{ store.needsRenewal() ? 'requiere renovación' : 'vigente' }} · Peticiones simuladas:
        {{ transport.requests() }}
      </p>
      <div class="actions">
        <button class="outline-button" (click)="store.local.setMode('online')">Simular modo online</button>
        <button class="outline-button" (click)="store.local.setMode('offline')">Simular modo offline</button>
        <button class="outline-button" (click)="store.deviceConnection.set('interrupted')">Simular corte de conexión</button>
        <button class="outline-button" (click)="store.deviceConnection.set('connected')">Simular reconexión</button>
        <button class="outline-button" (click)="store.requireRenewal()">Simular caducidad</button>
        <button class="outline-button" (click)="store.requestRenewal()">Abrir renovación</button>
        <button class="outline-button" (click)="closeOnline()" [disabled]="store.busy()">
          Cerrar sesión online simulada
        </button>
      </div>
      <label
        >Respuesta del próximo intento
        <select (change)="transport.status.set(+$any($event.target).value)">
          <option value="200">Éxito</option>
          <option value="401">Contraseña incorrecta</option>
          <option value="429">Demasiados intentos</option>
          <option value="503">Servicio no disponible</option>
          <option value="0">Sin red</option>
        </select>
      </label>
      <p>
        Escribe cualquier texto como contraseña de prueba. «Ahora no» descarta el formulario; si ya
        enviaste una petición, su respuesta puede llegar, pero no cambia de modo ni interrumpe
        audio.
      </p>
      @if (message()) {
        <p role="status">{{ message() }}</p>
      }
      <app-renew-access />
      <p class="muted">
        Esto comprueba el desacoplamiento del acceso y un elemento de audio local. No acredita
        todavía el reproductor offline completo, Service Worker, códecs ni continuidad tras
        recargar.
      </p>
    </main>
  `,
  styles: `
    main {
      max-width: 960px;
      margin: auto;
      padding: 40px 24px;
    }
    p {
      line-height: 1.65;
    }
    audio {
      width: 100%;
      margin: 20px 0;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 24px 0;
    }
    select {
      display: block;
      margin-top: 12px;
      padding: 12px;
      background: var(--surface);
      color: var(--text);
    }
    .muted {
      margin-top: 32px;
    }
  `,
})
export class LocalSessionLabComponent {
  protected readonly store = inject(SessionStore);
  protected readonly transport = inject(SyntheticAuth);
  protected readonly playing = signal(false);
  protected readonly seconds = signal(0);
  protected readonly message = signal('');
  protected readonly audioUrl: string;
  constructor() {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
      throw new Error('Local laboratory only');
    if (!this.store.local.value()) this.store.acceptAuthenticatedSession(session());
    this.store.local.setMode('offline');
    const size = 8000 * 60 * 2,
      buffer = new ArrayBuffer(44 + size),
      view = new DataView(buffer);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + size, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, size, true);
    this.audioUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    inject(DestroyRef).onDestroy(() => URL.revokeObjectURL(this.audioUrl));
  }
  protected async closeOnline(): Promise<void> {
    try {
      await this.store.logout();
      this.message.set('Cierre online confirmado; audio y perfil local conservados.');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'No se confirmó el cierre.');
    }
  }
}
