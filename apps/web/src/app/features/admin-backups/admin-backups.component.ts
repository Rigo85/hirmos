import { DatePipe, DecimalPipe, DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import type { BackupStatusResponse } from '@hirmos/contracts';
import { AccessStatusComponent } from '../../shared/access-status.component';

@Component({
  selector: 'app-admin-backups', imports: [AccessStatusComponent, DatePipe, DecimalPipe, RouterLink],
  templateUrl: './admin-backups.component.html', styleUrl: './admin-backups.component.scss',
})
export class AdminBackupsComponent {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly destroy = inject(DestroyRef);
  protected readonly status = signal<BackupStatusResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly phases = {
    destination: 'Comprobar destino', snapshot: 'Copiar base y letras', files: 'Copiar configuración',
    verification: 'Verificar archivos', retention: 'Limpiar copias antiguas', complete: 'Completada',
  };
  protected readonly outcomes = {
    running: 'En curso', succeeded: 'Completado', failed: 'Falló', warning: 'Terminó con advertencia',
    interrupted: 'Interrumpido: ya no hay una ejecución activa',
  };
  constructor() {
    void this.load();
    const timer = setInterval(() => { if (!this.document.hidden) void this.load(); }, 60000);
    const visible = () => { if (!this.document.hidden) void this.load(); };
    this.document.addEventListener('visibilitychange', visible);
    this.destroy.onDestroy(() => {
      clearInterval(timer); this.document.removeEventListener('visibilitychange', visible);
    });
  }
  protected async load(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true); this.error.set('');
    try {
      const result = await firstValueFrom(this.http.get<BackupStatusResponse>('/api/admin/backups').pipe(timeout(15000)));
      if (!this.destroy.destroyed) this.status.set(result);
    } catch {
      if (!this.destroy.destroyed) this.error.set('No pudimos consultar el estado. Los datos anteriores, si aparecen, no están actualizados.');
    } finally { if (!this.destroy.destroyed) this.loading.set(false); }
  }
}
