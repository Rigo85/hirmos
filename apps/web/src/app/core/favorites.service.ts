import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { FavoriteTrackResponse, Track } from '@hirmos/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { SessionStore } from './session.store';

@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionStore);
  // A new identity/access context gets fresh optimistic state synchronously,
  // even before Angular has run effects. Old completions only see their scope.
  private readonly scope = computed(() => ({
    session: this.session.session(), owner: this.session.localOwner(),
    allowed: this.session.canUseRemote(),
    overrides: signal<Record<string, boolean>>({}),
    pending: signal<Set<string>>(new Set()),
    error: signal<string | null>(null),
  }));
  public get error() { return this.scope().error; }

  public isFavorite(track: Track): boolean {
    return this.scope().overrides()[track.id] ?? track.favorite;
  }

  public isPending(reference: string): boolean {
    return this.scope().pending().has(reference);
  }

  public async toggle(track: Track): Promise<boolean | null> {
    const generation = this.session.requestGeneration();
    const scope = this.scope();
    if (!scope.allowed || !scope.owner || this.isPending(track.id)) return null;
    const current = () => generation === this.session.requestGeneration() && this.scope() === scope;
    const previous = scope.overrides()[track.id];
    const favorite = !this.isFavorite(track);
    scope.overrides.update((values) => ({ ...values, [track.id]: favorite }));
    scope.pending.update((values) => new Set(values).add(track.id));
    scope.error.set(null);
    try {
      const result = await firstValueFrom(this.http.put<FavoriteTrackResponse>(
        `/api/library/tracks/${encodeURIComponent(track.id)}/favorite`, { favorite },
      ).pipe(timeout(10_000)));
      if (!current()) return null;
      scope.overrides.update((values) => ({ ...values, [track.id]: result.favorite }));
      return result.favorite;
    } catch {
      if (!current()) return null;
      scope.overrides.update((values) => {
        const restored = { ...values };
        if (previous === undefined) delete restored[track.id];
        else restored[track.id] = previous;
        return restored;
      });
      scope.error.set('No pudimos actualizar tus favoritos.');
      return null;
    } finally {
      scope.pending.update((values) => {
        const next = new Set(values); next.delete(track.id); return next;
      });
    }
  }
}
