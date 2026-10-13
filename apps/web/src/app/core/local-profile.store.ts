import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import type { SessionResponse } from '@hirmos/contracts';

export const LOCAL_PROFILE_KEY = 'hirmos.local-profile.v1';
export const PROFILE_STORAGE_KEY = new InjectionToken<string>('local profile namespace', {
  providedIn: 'root',
  factory: () => LOCAL_PROFILE_KEY,
});
export interface LocalProfile {
  version: 1;
  user: { id: string; email: string; displayName: string };
  expiresAt: string;
  mode: 'online' | 'offline';
  remote: 'unknown' | 'required' | 'closed';
  revision: string;
}
export function readLocalProfile(key = LOCAL_PROFILE_KEY): LocalProfile | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      p?.version !== 1 ||
      !/^[a-f0-9-]{36}$/i.test(p.user?.id ?? '') ||
      typeof p.user.email !== 'string' ||
      p.user.email.length > 320 ||
      typeof p.user.displayName !== 'string' ||
      p.user.displayName.length > 100 ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      !['online', 'offline'].includes(p.mode) ||
      !['unknown', 'required', 'closed'].includes(p.remote) ||
      typeof p.revision !== 'string'
    )
      return null;
    return {
      version: 1,
      user: { id: p.user.id, email: p.user.email, displayName: p.user.displayName },
      expiresAt: p.expiresAt,
      mode: p.mode,
      remote: p.remote,
      revision: p.revision,
    };
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class LocalProfileStore {
  readonly key = inject(PROFILE_STORAGE_KEY);
  readonly value = signal<LocalProfile | null>(readLocalProfile(this.key));
  readonly conflict = signal(false);
  readonly storageError = signal('');
  readonly offline = computed(() => this.value()?.mode === 'offline');
  private channel: BroadcastChannel | null = null;
  constructor() {
    const refresh = () => this.refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === this.key || event.key === null) refresh();
    };
    window.addEventListener('storage', storage);
    window.addEventListener('focus', refresh);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', visible);
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(this.key);
      this.channel.onmessage = refresh;
    }
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      this.channel?.close();
    });
  }
  refresh(): void {
    const saved = readLocalProfile(this.key),
      current = this.value();
    if (current && saved?.user.id !== current.user.id) {
      // A different cookie/profile must not adopt the running local player's files.
      this.conflict.set(true);
      return;
    }
    if (saved?.revision !== current?.revision) this.value.set(saved);
  }
  accept(session: SessionResponse, replace = false): void {
    const current = this.value();
    if (!replace && current && current.user.id !== session.user.id)
      throw new Error('ACCOUNT_CHANGED');
    // An ordinary session check in another tab must not look like an auth transition.
    if (
      !replace &&
      !this.conflict() &&
      current?.remote === 'unknown' &&
      current.expiresAt === session.expiresAt &&
      current.user.id === session.user.id &&
      current.user.email === session.user.email &&
      current.user.displayName === session.user.displayName
    )
      return;
    this.write({
      version: 1,
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      expiresAt: session.expiresAt,
      mode: replace ? 'online' : (current?.mode ?? 'online'),
      remote: 'unknown',
      revision: crypto.randomUUID(),
    });
    this.conflict.set(false);
  }
  mark(remote: LocalProfile['remote']): void {
    this.refresh();
    if (this.conflict()) return;
    const p = this.value();
    if (p) this.write({ ...p, remote, revision: crypto.randomUUID() });
  }
  /** Commit only after an explicit, coordinated mode transition. */
  setMode(mode: LocalProfile['mode']): void {
    this.refresh();
    if (this.conflict()) throw new Error('ACCOUNT_CHANGED');
    const p = this.value();
    if (!p) throw new Error('LOCAL_PROFILE_REQUIRED');
    if(p.mode===mode)return;
    this.write({ ...p, mode, revision: crypto.randomUUID() });
  }
  private write(value: LocalProfile): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(value));
      this.storageError.set('');
    } catch {
      this.storageError.set('No pudimos guardar el perfil local en este navegador.');
      throw new Error('LOCAL_PROFILE_WRITE_FAILED');
    }
    this.value.set(value);
    this.channel?.postMessage('changed');
  }
}
