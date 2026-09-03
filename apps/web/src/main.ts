import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

void start();

async function start(): Promise<void> {
  const controlled = Boolean(navigator.serviceWorker?.controller);
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if ('caches' in globalThis) {
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith('ngsw:')).map((name) => caches.delete(name)));
      }
      if (controlled) {
        location.reload();
        return;
      }
    } catch {
      // A failed cleanup must not prevent the web application from starting.
    }
  }

  await bootstrapApplication(App, appConfig);
}
