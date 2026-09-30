import { DatePipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';

@Component({
  selector: 'app-playback-failures',
  imports: [DatePipe],
  template: `
    @if (history()) {
      @if (notices().length) {
        <button class="history-toggle" type="button" (click)="playback.failureDetailsOpen.set(!playback.failureDetailsOpen())"
          [attr.aria-expanded]="playback.failureDetailsOpen()">Incidencias</button>
        @if (playback.failureDetailsOpen()) {
          <div class="history" aria-label="Historial de incidencias">
            <ol>@for (notice of notices(); track notice.id) {
              <li><time>{{ notice.occurredAt | date:'shortTime' }}</time> — {{ playback.failureText(notice) }}
                <small>{{ active()?.id === notice.id ? 'Pendiente' : 'Registro anterior' }} · {{ notice.code }} · {{ notice.phase }}</small>
              </li>
            }</ol>
            <small>Últimas incidencias técnicas; no cuentan como rechazo musical.</small>
          </div>
        }
      }
    } @else {
      @let pending = playback.unconfirmedFailure();
      @let authentication = playback.authenticationRequired();
      @let latest = active();
      @if (pending || authentication || (latest && playback.dismissedFailure() !== latest.id)) {
        <section aria-label="Incidencias de reproducción">
          @if (authentication) {
            <p role="status">Tu sesión terminó. Conservamos la cola y el último punto confirmado.</p>
            <a href="/login">Iniciar sesión</a>
          } @else if (pending) {
            <p role="status">El audio se detuvo en este dispositivo. La incidencia está pendiente de confirmar con el servidor.</p>
            @if (playback.ownsLease()) {
              <button type="button" (click)="playback.retryFailureReport()">Volver a confirmar</button>
            } @else {
              <button type="button" (click)="playback.claimHere()">Reproducir aquí</button>
            }
          } @else if (latest) {
            <p role="status">{{ playback.failureText(latest) }}</p>
            <button type="button" (click)="playback.dismissedFailure.set(latest.id)">Cerrar aviso</button>
            @if (latest.code === 'authentication') {
              <a href="/login">Iniciar sesión</a>
            } @else if (playback.snapshot()?.renderPhase === 'error' || playback.snapshot()?.renderPhase === 'blocked') {
              <span class="retry-action">
                <button type="button" (click)="playback.retryCurrent()" [disabled]="playback.retryWaitSeconds() > 0">Reintentar pista actual</button>
                @if (playback.retryWaitSeconds(); as seconds) {
                  <span class="retry-wait" role="timer" aria-live="off">Disponible en {{ seconds }} s · espera solicitada por el servicio.</span>
                }
              </span>
              @if (!['service_unavailable','offline'].includes(latest.code)) {
                <button type="button" (click)="playback.next()">Siguiente</button>
              }
            }
          }
        </section>
      }
    }
  `,
  styles: `
    :host { display: block; }
    section { margin: .6rem 1rem; padding: .65rem .9rem; border: 1px solid #a87932; border-radius: .6rem; background: #241e14; color: #f2e8d7; font-size: .9rem; }
    p { margin: 0 0 .4rem; }
    button { color: inherit; background: transparent; border: 1px solid #766343; border-radius: .35rem; padding: .4rem .55rem; margin: .2rem .4rem .2rem 0; cursor: pointer; }
    button:focus-visible { outline: 2px solid #efb65c; outline-offset: 2px; }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .retry-action { display:inline-flex; align-items:center; flex-wrap:wrap; gap:.35rem; max-width:100%; }
    .retry-wait { font-size:.85rem; opacity:.85; }
    .history-toggle { border:0; font-size:.85rem; }
    .history { font-size:.85rem; padding:.5rem; }
    ol { max-height: 12rem; overflow: auto; padding-left: 1.2rem; }
    li { margin-bottom: .6rem; }
    small { display: block; opacity: .85; }
  `,
})
export class PlaybackFailuresComponent {
  protected readonly playback = inject(PlaybackSyncService);
  readonly history = input(false);
  protected readonly notices = computed(() => (this.playback.snapshot()?.failures ?? []).filter(n => n.code !== 'autoplay'));
  protected readonly active = computed(() => {
    const snapshot = this.playback.snapshot();
    const latest = this.notices().at(-1);
    if (!snapshot || !latest) return null;
    if (['error', 'blocked'].includes(snapshot.renderPhase) && latest.trackRef === snapshot.currentTrackRef) return latest;
    if (latest.outcome === 'advanced' && ['loading','buffering'].includes(snapshot.renderPhase)) return latest;
    return null;
  });
}
