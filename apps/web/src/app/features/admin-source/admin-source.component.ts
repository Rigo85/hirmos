import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AdminMusicSource } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-admin-source',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './admin-source.component.html',
})
export class AdminSourceComponent {
  private readonly http = inject(HttpClient);
  protected readonly source = signal<AdminMusicSource | null>(null);
  protected readonly working = signal<'probe' | 'save' | null>(null);
  protected readonly message = signal<{ kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly form = new FormGroup({
    name: new FormControl('Biblioteca principal', { nonNullable: true, validators: [Validators.required] }),
    baseUrl: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  public constructor() {
    void this.load();
  }

  protected async probe(): Promise<void> {
    await this.submit('probe', '/api/admin/music-source/probe');
  }

  protected async save(): Promise<void> {
    await this.submit('save', '/api/admin/music-source');
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
