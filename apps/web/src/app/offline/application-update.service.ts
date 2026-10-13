import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** Inform only. Never activate a new bundle in a running audio session, reload,
 * erase caches, or migrate downloaded music as a side effect of an update. */
@Injectable({ providedIn: 'root' })
export class ApplicationUpdateService {
  private readonly updates = inject(SwUpdate, { optional: true });
  readonly message = signal('');

  constructor() {
    if (!this.updates?.isEnabled) return;
    const versions = this.updates.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') {
        this.message.set('Hay una actualización de Hirmos preparada. Se aplicará al volver a abrir o recargar la aplicación; no interrumpiremos tu reproducción.');
      } else if (event.type === 'VERSION_INSTALLATION_FAILED') {
        this.message.set('No se pudo preparar la actualización de Hirmos. La versión abierta y tus descargas se conservan.');
      }
    });
    const recovery = this.updates.unrecoverable.subscribe(() => {
      this.message.set('La copia de la aplicación está incompleta. Cuando tengas conexión, recarga Hirmos al terminar de escuchar. No borres los datos del navegador: ahí están tus descargas.');
    });
    inject(DestroyRef).onDestroy(() => { versions.unsubscribe(); recovery.unsubscribe(); });
  }
}
