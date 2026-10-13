import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { SessionStore } from './session.store';
import { PlaybackModeService } from './playback-mode.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const sessionStore = inject(SessionStore);
  const router = inject(Router);
  const session = await sessionStore.load();
  if (session) return true;
  // Restore an explicitly chosen local mode, never infer it from a failed request.
  if (sessionStore.localOwner() && sessionStore.local.offline()) return router.createUrlTree(['/local']);
  return router.createUrlTree([
    !sessionStore.localOwner() && sessionStore.remoteStatus() === 'required' ? '/login' : '/access',
  ], { queryParams: { returnUrl: state.url } });
};

export const localProfileGuard: CanActivateFn = async () => {
  const store=inject(SessionStore),router=inject(Router),mode=inject(PlaybackModeService);
  if(!store.localOwner())return router.createUrlTree(['/login']);
  if(!store.local.conflict())await mode.enterLocal();
  return true;
};
