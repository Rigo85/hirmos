import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type { FavoriteTrackResponse, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly http = inject(HttpClient);
  private readonly overrides = signal<Record<string, boolean>>({});
  private readonly pendingReferences = signal<Set<string>>(new Set());
  public readonly error = signal<string | null>(null);

  public isFavorite(track: Track): boolean {
    return this.overrides()[track.id] ?? track.favorite;
  }

  public isPending(reference: string): boolean {
    return this.pendingReferences().has(reference);
  }

  public async toggle(track: Track): Promise<boolean | null> {
    if (this.isPending(track.id)) return null;
    const previous = this.overrides()[track.id];
    const favorite = !this.isFavorite(track);
    this.overrides.update((values) => ({ ...values, [track.id]: favorite }));
    this.pendingReferences.update((values) => new Set(values).add(track.id));
    this.error.set(null);
    try {
      const result = await firstValueFrom(this.http.put<FavoriteTrackResponse>(
        `/api/library/tracks/${encodeURIComponent(track.id)}/favorite`, { favorite },
      ));
      this.overrides.update((values) => ({ ...values, [track.id]: result.favorite }));
      return result.favorite;
    } catch {
      this.overrides.update((values) => {
        const restored = { ...values };
        if (previous === undefined) delete restored[track.id];
        else restored[track.id] = previous;
        return restored;
      });
      this.error.set('No pudimos actualizar tus favoritos.');
      return null;
    } finally {
      this.pendingReferences.update((values) => {
        const next = new Set(values); next.delete(track.id); return next;
      });
    }
  }
}
