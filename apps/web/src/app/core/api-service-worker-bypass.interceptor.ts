import { type HttpInterceptorFn } from '@angular/common/http';

/**
 * API responses are never cached by Hirmos. Explicitly bypassing Angular's
 * service worker also prevents it from converting a transient fetch failure
 * into its own synthetic 504 response before the request reaches Nginx.
 */
export const apiServiceWorkerBypassInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  return next(request.clone({
    headers: request.headers.set('ngsw-bypass', 'true'),
  }));
};
