import { Component, inject } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';

@Component({
  selector: 'app-audio-permission',
  template: `
    @if (playback.waitingForAudio()) {
      <div class="audio-permission" role="status">
        @if (playback.ownsLease()) {
          <span>{{ playback.permissionStillBlocked() ? 'El navegador sigue bloqueando el audio. Revisa el permiso de sonido del sitio.' : 'Reproducción automática bloqueada.' }}</span>
          <button type="button" (click)="playback.continueAudio()" [disabled]="!playback.connected() || playback.continuingAudio()">Pulsa para continuar</button>
        } @else if (playback.hasActiveRemotePlayer()) {
          <span>El otro dispositivo necesita habilitar el audio.</span>
          <button type="button" (click)="playback.claimHere()" [disabled]="!playback.connected()">Reproducir aquí</button>
        } @else {
          <span>La reproducción está en espera.</span>
          <button type="button" (click)="playback.continueAudio()" [disabled]="!playback.connected()">Continuar aquí</button>
        }
      </div>
    }
  `,
  styles: `
    :host { display:block; }
    :host:empty { display:none; }
    :host(.desktop-audio-permission) { position:absolute; bottom:100%; left:50%; transform:translateX(-50%); max-width:calc(100vw - 2rem); padding:.35rem .65rem; background:#10141a; border-radius:.5rem .5rem 0 0; }
    @media (max-width: 760px) { :host(.desktop-audio-permission) { display:none; } }
    .audio-permission { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem; font-size:.85rem; color:var(--text-muted, #a9afb8); }
    button { font:inherit; color:inherit; background:none; border:0; text-decoration:underline; cursor:pointer; padding:.4rem; }
    button:disabled { opacity:.5; cursor:default; }
  `,
})
export class AudioPermissionComponent { protected readonly playback = inject(PlaybackSyncService); }
