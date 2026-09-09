import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  AdminMusicSource, CatalogSyncStatus, CatalogSyncTriggerResponse,
} from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-admin-source',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './admin-source.component.html',
})
export class AdminSourceComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private pollingSync = false;
  private destroyed = false;
  protected readonly source = signal<AdminMusicSource | null>(null);
  protected readonly working = signal<'probe' | 'save' | null>(null);
  protected readonly message = signal<{ kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly syncStatus = signal<CatalogSyncStatus>({
    status: 'idle', startedAt: null, completedAt: null, counts: null,
  });
  protected readonly syncSubmitting = signal(false);
  protected readonly syncMessage = signal<{ kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly form = new FormGroup({
    name: new FormControl('Biblioteca principal', { nonNullable: true, validators: [Validators.required] }),
    baseUrl: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  public constructor() {
    this.destroyRef.onDestroy(() => { this.destroyed = true; });
    void this.initialize();
  }

  protected async probe(): Promise<void> {
    await this.submit('probe', '/api/admin/music-source/probe');
  }

  protected async save(): Promise<void> {
    await this.submit('save', '/api/admin/music-source');
  }

  protected async syncNow(): Promise<void> {
    if (!this.source() || this.syncSubmitting() || this.syncStatus().status === 'running') return;
    this.syncSubmitting.set(true);
    this.syncMessage.set(null);
    try {
      const response = await firstValueFrom(
        this.http.post<CatalogSyncTriggerResponse>('/api/admin/music-source/sync', {}),
      );
      this.syncStatus.set(response);
      this.syncMessage.set({
        kind: 'success',
        text: response.started
          ? 'Sincronización iniciada. Puedes permanecer en esta pantalla mientras termina.'
          : 'Ya había una sincronización en curso; mostraremos su resultado.',
      });
      void this.pollSyncUntilFinished();
    } catch {
      this.syncMessage.set({
        kind: 'error', text: 'No pudimos iniciar la sincronización del catálogo.',
      });
    } finally {
      this.syncSubmitting.set(false);
    }
  }

  protected syncBadge(): string {
    if (this.syncStatus().status === 'running') return 'Sincronizando';
    if (this.syncStatus().status === 'failed') return 'Falló';
    return this.source()?.lastSyncedAt ? 'Actualizado' : 'Pendiente';
  }

  protected formatDate(value: string | null | undefined): string {
    if (!value) return 'Todavía no se ha completado un barrido.';
    return new Intl.DateTimeFormat('es', {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(value));
  }

  private async initialize(): Promise<void> {
    await Promise.all([this.load(), this.loadSyncStatus()]);
    if (this.syncStatus().status === 'running') void this.pollSyncUntilFinished();
  }

  private async load(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ source: AdminMusicSource | null }>('/api/admin/music-source'),
      );
      this.source.set(response.source);
      if (response.source) {
        this.form.patchValue({ name: response.source.name, baseUrl: response.source.baseUrl });
      }
    } catch {
      this.message.set({ kind: 'error', text: 'No pudimos leer la configuración actual.' });
    }
  }

  private async loadSyncStatus(): Promise<void> {
    try {
      this.syncStatus.set(await firstValueFrom(
        this.http.get<CatalogSyncStatus>('/api/admin/music-source/sync'),
      ));
    } catch {
      this.syncMessage.set({
        kind: 'error', text: 'No pudimos consultar el estado de sincronización.',
      });
    }
  }

  private async pollSyncUntilFinished(): Promise<void> {
    if (this.pollingSync) return;
    this.pollingSync = true;
    try {
      while (!this.destroyed && this.syncStatus().status === 'running') {
        await wait(1_500);
        if (this.destroyed) return;
        try {
          const status = await firstValueFrom(
            this.http.get<CatalogSyncStatus>('/api/admin/music-source/sync'),
          );
          this.syncStatus.set(status);
        } catch {
          this.syncMessage.set({
            kind: 'error',
            text: 'La sincronización sigue en segundo plano, pero no pudimos consultar su estado.',
          });
          return;
        }
      }

      if (this.syncStatus().status === 'succeeded') {
        const counts = this.syncStatus().counts;
        this.syncMessage.set({
          kind: 'success',
          text: counts
            ? `Catálogo actualizado: ${counts.artists} artistas, ${counts.albums} álbumes y ${counts.tracks} canciones.`
            : 'El catálogo quedó actualizado.',
        });
        await this.load();
      } else if (this.syncStatus().status === 'failed') {
        this.syncMessage.set({
          kind: 'error',
          text: 'La sincronización no pudo completarse. El catálogo anterior permanece disponible.',
        });
      }
    } finally {
      this.pollingSync = false;
    }
  }

  private async submit(action: 'probe' | 'save', url: string): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.working()) return;
    this.working.set(action);
    this.message.set(null);
    try {
      if (action === 'save') {
        const response = await firstValueFrom(
          this.http.put<{ source: AdminMusicSource }>(url, this.form.getRawValue()),
        );
        this.source.set(response.source);
        this.form.controls.password.reset('');
        this.message.set({ kind: 'success', text: 'Fuente validada y guardada.' });
      } else {
        const response = await firstValueFrom(
          this.http.post<{ serverVersion: string | null }>(url, this.form.getRawValue()),
        );
        this.message.set({
          kind: 'success',
          text: `Conexión correcta${response.serverVersion ? ` · versión ${response.serverVersion}` : ''}.`,
        });
      }
    } catch {
      this.message.set({ kind: 'error', text: 'No pudimos conectar. Revisa la URL y las credenciales.' });
    } finally {
      this.working.set(null);
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
