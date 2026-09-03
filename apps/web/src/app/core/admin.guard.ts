import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { SessionStore } from './session.store';

export const adminGuard: CanActivateFn = async () => {
  const session = await inject(SessionStore).load();
  return session?.user.role === 'admin' ? true : inject(Router).createUrlTree(['/']);
};
