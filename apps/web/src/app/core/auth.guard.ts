import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { SessionStore } from './session.store';

export const authGuard: CanActivateFn = async (_route, state) => {
  const sessionStore = inject(SessionStore);
  const router = inject(Router);
  const session = await sessionStore.load();
  return session ? true : router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
