import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { apiServiceWorkerBypassInterceptor } from './core/api-service-worker-bypass.interceptor';
import { localModeInterceptor } from './core/local-mode.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([localModeInterceptor, apiServiceWorkerBypassInterceptor])),
    provideRouter(routes),
    provideServiceWorker('hirmos-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerImmediately',
      updateViaCache: 'none',
    }),
  ]
};
