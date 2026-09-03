import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type { LoginRequest, SessionResponse } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly http = inject(HttpClient);
  private loaded = false;

  readonly session = signal<SessionResponse | null>(null);

  async load(): Promise<SessionResponse | null> {
    if (this.loaded) return this.session();
    try {
      const session = await firstValueFrom(
        this.http.get<SessionResponse>('/api/auth/session', { withCredentials: true }),
      );
      this.session.set(session);
    } catch (error) {
      this.session.set(null);
      this.loaded = error instanceof HttpErrorResponse && error.status === 401;
    }
    if (this.session()) this.loaded = true;
    return this.session();
  }

  async login(input: LoginRequest): Promise<SessionResponse> {
    try {
      const session = await firstValueFrom(
        this.http.post<SessionResponse>('/api/auth/login', input, {
          withCredentials: true,
        }),
      );
      this.loaded = true;
      this.session.set(session);
      return session;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        throw new Error('El correo o la contraseña no son válidos.');
      }
      if (error instanceof HttpErrorResponse && error.status === 429) {
        const seconds = Number(error.headers.get('retry-after'));
        throw new Error(Number.isFinite(seconds) && seconds > 0
          ? `Demasiados intentos. Vuelve a probar en ${Math.ceil(seconds / 60)} minutos.`
          : 'Demasiados intentos. Espera un momento antes de volver a probar.');
      }
      throw new Error('No pudimos iniciar sesión. Inténtalo nuevamente.');
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<void>('/api/auth/logout', null, { withCredentials: true }),
      );
    } finally {
      this.loaded = true;
      this.session.set(null);
    }
  }
}
