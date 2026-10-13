import { HttpClient, HttpContext, HttpContextToken, HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { LoginRequest, SessionResponse } from '@hirmos/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { LocalProfileStore, readLocalProfile } from './local-profile.store';

export const EXPLICIT_AUTH = new HttpContextToken<boolean>(() => false);
const authOptions = () => ({
  withCredentials: true,
  context: new HttpContext().set(EXPLICIT_AUTH, true),
});
const REQUEST_TIMEOUT = 10_000;

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly http = inject(HttpClient);
  readonly local = inject(LocalProfileStore);
  private profileRevision = this.local.value()?.revision;
  private loaded = false;
  private generation = 0;
  private remoteCheck: Promise<SessionResponse | null> | null = null;
  private readonly now = signal(Date.now());
  readonly session = signal<SessionResponse | null>(null);
  readonly busy = signal(false);
  readonly renewalRequested = signal(false);
  readonly renewed = signal(0);
  readonly remoteStatus = signal<'unknown' | 'available' | 'unreachable' | 'required' | 'forbidden' | 'throttled'>('unknown');
  readonly checking = signal(false);
  private readonly checkRetryAt = signal(0);
  readonly checkWaitSeconds = computed(() => Math.max(0, Math.ceil((this.checkRetryAt() - this.now()) / 1000)));
  readonly deviceConnection = signal<'unknown' | 'connected' | 'interrupted'>('unknown');
  readonly localOwner = computed(
    () => this.local.value()?.user.id ?? this.session()?.user.id ?? null,
  );
  readonly needsRenewal = computed(() => {
    const p = this.local.value();
    return (
      !!p &&
      (p.remote !== 'unknown' || Date.parse(p.expiresAt) <= this.now() || this.local.conflict())
    );
  });
  readonly canUseRemote = computed(
    () =>
      !this.local.offline() && !this.local.conflict() && !!this.session() && !this.needsRenewal(),
  );
  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const next = this.local.value()?.revision,
        conflict = this.local.conflict();
      if (next !== this.profileRevision || conflict) {
        this.profileRevision = next;
        untracked(() => {
          this.generation++;
          this.loaded = false;
          this.remoteCheck = null;
          this.session.set(null);
        });
      }
    });
  }
  clear(): void {
    this.requireRenewal();
  }
  acceptAuthenticatedSession(result: SessionResponse): void {
    this.accept(result);
  }
  closed(): void {
    this.remoteStatus.set('required');
    this.generation++;
    this.remoteCheck = null;
    this.loaded = true;
    this.session.set(null);
    this.local.mark('closed');
    this.profileRevision = this.local.value()?.revision;
  }
  requireRenewal(expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && expectedGeneration !== this.requestGeneration()) return;
    this.remoteStatus.set('required');
    this.generation++;
    this.loaded = true;
    this.remoteCheck = null;
    this.session.set(null);
    if (!this.local.conflict())
      try {
        this.local.mark('required');
        this.profileRevision = this.local.value()?.revision;
      } catch {
        /* memory access remains available */
      }
  }
  requestGeneration(): number {
    // Storage notifications and HTTP completion may run before Angular's next effect.
    const revision = this.local.value()?.revision;
    if (revision !== this.profileRevision) {
      this.profileRevision = revision;
      this.generation++;
      this.loaded = false;
      this.remoteCheck = null;
      this.session.set(null);
    }
    return this.generation;
  }
  requestRenewal(): void {
    if (this.localOwner()) this.renewalRequested.set(true);
  }
  dismissRenewal(): void {
    this.renewalRequested.set(false);
  }
  async load(): Promise<SessionResponse | null> {
    if (this.local.offline() || this.needsRenewal() || this.local.conflict()) return null;
    if (this.loaded) return this.session();
    return this.checkRemote();
  }
  async checkRemote(explicit = false): Promise<SessionResponse | null> {
    if (this.busy() || this.local.conflict() || (this.local.offline() && !explicit)) return null;
    if (Date.now() < this.checkRetryAt()) return null;
    if (this.remoteCheck) return this.remoteCheck;
    const generation = this.requestGeneration(),
      owner = this.localOwner();
    this.checking.set(true);
    const operation = (async () => {
      try {
        const raw = await firstValueFrom(
          this.http
            .get<SessionResponse>(
              '/api/auth/session',
              explicit ? authOptions() : { withCredentials: true },
            )
            .pipe(timeout(REQUEST_TIMEOUT)),
        );
        if (generation !== this.requestGeneration()) return this.session();
        const result = parseSessionResponse(raw);
        if (owner && result.user.id !== owner) {
          this.local.conflict.set(true);
          this.session.set(null);
          return null;
        }
        this.accept(result);
        return result;
      } catch (error) {
        if (generation !== this.requestGeneration()) return this.session();
        if (error instanceof HttpErrorResponse && [429, 503].includes(error.status)) {
          const header = error.headers.get('retry-after');
          const seconds = header === null ? NaN : Number(header);
          const until = header === null ? NaN : Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header);
          this.now.set(Date.now());
          this.checkRetryAt.set(Number.isFinite(until) ? Math.max(Date.now(), until) : Date.now() + 30_000);
        }
        if (error instanceof HttpErrorResponse && error.status === 401)
          this.requireRenewal(generation);
        else this.remoteStatus.set(error instanceof HttpErrorResponse && error.status === 403
          ? 'forbidden' : error instanceof HttpErrorResponse && error.status === 429 ? 'throttled' : 'unreachable');
        return null;
      }
    })();
    this.remoteCheck = operation;
    try {
      return await operation;
    } finally {
      if (this.remoteCheck === operation) { this.remoteCheck = null; this.checking.set(false); }
      else if (!this.remoteCheck) this.checking.set(false);
    }
  }
  private accept(result: SessionResponse, replace = false): void {
    this.checkRetryAt.set(0);
    this.remoteStatus.set('available');
    this.local.accept(result, replace);
    this.profileRevision = this.local.value()?.revision;
    this.loaded = true;
    this.session.set(result);
    this.now.set(Date.now());
  }
  async login(input: LoginRequest): Promise<SessionResponse> {
    return this.mutate(async () => {
      const result = parseSessionResponse(
        await firstValueFrom(
          this.http
            .post<SessionResponse>('/api/auth/login', input, authOptions())
            .pipe(timeout(REQUEST_TIMEOUT)),
        ),
      );
      this.accept(result, true);
      return result;
    });
  }
  async renew(password: string): Promise<void> {
    const profile = this.local.value();
    if (!profile) throw new Error('No hay un perfil local que renovar.');
    await this.mutate(async () => {
      this.assertProfile(profile.user.id);
      const revision = this.local.value()?.revision;
      const result = parseSessionResponse(
        await firstValueFrom(
          this.http
            .post<SessionResponse>(
              '/api/auth/renew',
              {
                email: profile.user.email,
                password,
                expectedUserId: profile.user.id,
              },
              authOptions(),
            )
            .pipe(timeout(REQUEST_TIMEOUT)),
        ),
      );
      this.local.refresh();
      this.assertProfile(profile.user.id);
      if (this.local.value()?.revision !== revision) throw new Error('STALE_ACCESS');
      if (result.user.id !== profile.user.id) throw new Error('ACCOUNT_CHANGED');
      this.accept(result);
      this.renewed.update((n) => n + 1);
      this.dismissRenewal();
    });
  }
  async logout(): Promise<void> {
    const owner = this.localOwner();
    try {
      await this.mutate(async () => {
        if (owner) this.assertProfile(owner);
        await firstValueFrom(
          this.http
            .post<void>('/api/auth/logout', owner ? { expectedUserId: owner } : null, authOptions())
            .pipe(timeout(REQUEST_TIMEOUT)),
        );
        this.closed();
      });
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes('otra cuenta')
          ? error.message
          : 'No pudimos confirmar el cierre de la sesión online. El perfil y las descargas locales se conservan.',
      );
    }
  }
  private assertProfile(owner: string): void {
    const durable = readLocalProfile(this.local.key);
    if (this.localOwner() !== owner || this.local.conflict() || durable?.user.id !== owner)
      throw new Error('ACCOUNT_CHANGED');
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy()) throw new Error('Ya hay una operación de acceso en curso.');
    this.busy.set(true);
    this.generation++;
    this.remoteCheck = null;
    try {
      const run = async () => {
        this.local.refresh();
        return operation();
      };
      return await (navigator.locks
        ? navigator.locks.request('hirmos.auth-mutation.v1', run)
        : run());
    } catch (error) {
      throw accessError(error);
    } finally {
      this.busy.set(false);
    }
  }
}
/** Narrow the HTTP response, without importing the server's full schema runtime into app bootstrap.
 * This metadata is never an authentication credential or a server-side authorization decision. */
export function parseSessionResponse(raw: unknown): SessionResponse {
  const value = raw as Partial<SessionResponse> | null,
    user = value?.user;
  if (
    !user ||
    typeof user.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(user.id) ||
    typeof user.email !== 'string' ||
    !user.email.includes('@') ||
    user.email.length > 320 ||
    typeof user.displayName !== 'string' ||
    !user.displayName.length ||
    user.displayName.length > 100 ||
    !['user', 'admin'].includes(user.role) ||
    typeof value?.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new Error('INVALID_SESSION');
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    expiresAt: value.expiresAt,
  };
}
function accessError(error: unknown): Error {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 401) return new Error('El correo o la contraseña no son válidos.');
    if (error.status === 403)
      return new Error('No tienes permiso para esta operación. Renovar no cambia tus permisos.');
    if (error.status === 409)
      return new Error('La sesión online pertenece a otra cuenta. Tu perfil local no cambió.');
    if (error.status === 429) {
      const seconds = Number(error.headers.get('retry-after'));
      return new Error(
        Number.isFinite(seconds) && seconds > 0
          ? `Demasiados intentos. Vuelve a probar en ${Math.ceil(seconds / 60)} minutos.`
          : 'Demasiados intentos. Espera antes de volver a probar.',
      );
    }
  }
  if (error instanceof Error && error.message === 'ACCOUNT_CHANGED')
    return new Error('La sesión online pertenece a otra cuenta. Tu perfil local no cambió.');
  return new Error(
    'No pudimos confirmar el acceso online. Puedes continuar usando tus descargas locales e intentarlo más tarde.',
  );
}
