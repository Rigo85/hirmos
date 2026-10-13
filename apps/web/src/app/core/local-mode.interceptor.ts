import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { EXPLICIT_AUTH, SessionStore } from './session.store';

/** HTTP defense in depth; raw audio/download transports need their own mode gate. */
export const localModeInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  const store = inject(SessionStore);
  store.local.refresh();
  const explicit =
    request.context.get(EXPLICIT_AUTH) &&
    ['/api/auth/session', '/api/auth/renew', '/api/auth/logout', '/api/auth/login'].includes(
      request.url,
    );
  if (store.local.offline() && !explicit)
    return throwError(
      () => new HttpErrorResponse({ status: 0, statusText: 'LOCAL_MODE', url: request.url }),
    );
  if (store.local.conflict() && !explicit)
    return throwError(
      () => new HttpErrorResponse({ status: 0, statusText: 'ACCOUNT_CHANGED', url: request.url }),
    );
  const generation = store.requestGeneration();
  const owner = store.localOwner();
  // A confirmed identity mutation can itself revoke sockets before its HTTP reply.
  // Fence stale reads, but do not misreport that successful mutation as a failure.
  const revokesAccess =
    (request.method === 'DELETE' && /^\/api\/account\/sessions\/[^/]+$/.test(request.url)) ||
    (request.method === 'POST' && ['/api/account/sessions/revoke','/api/account/password'].includes(request.url)) ||
    (request.method === 'PATCH' && request.url.startsWith('/api/admin/users/'));
  return next(request).pipe(
    tap(() => {
      store.local.refresh();
      if (
        !explicit &&
        (store.local.conflict() ||
          owner !== store.localOwner() ||
          (!revokesAccess && generation !== store.requestGeneration()))
      )
        throw new HttpErrorResponse({ status: 0, statusText: 'STALE_ACCESS', url: request.url });
    }),
    catchError((error) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !request.url.startsWith('/api/auth/')
      )
        store.requireRenewal(generation);
      return throwError(() => error);
    }),
  );
};
