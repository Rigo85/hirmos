import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { AdminBackupsComponent } from './admin-backups.component';

const empty = { checkedAt:'2026-10-01T12:00:00Z', overdue:true, thresholdHours:36, lastAttempt:null, lastSuccess:null };
beforeEach(() => TestBed.configureTestingModule({ imports:[AdminBackupsComponent],
  providers:[provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }));
afterEach(() => TestBed.inject(HttpTestingController).verify());
it('shows missing receipt without claiming scheduling is active', async () => {
  const fixture = TestBed.createComponent(AdminBackupsComponent); fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/admin/backups').flush(empty);
  await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('No hay una copia verificada registrada');
  expect(fixture.nativeElement.textContent).toContain('no confirma que la tarea diaria esté instalada');
  fixture.destroy();
});
it('shows overdue copy, interrupted attempt and retains old data with explicit failure on refresh', async () => {
  const fixture = TestBed.createComponent(AdminBackupsComponent); fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/admin/backups').flush({ ...empty,
    lastSuccess:{ verifiedAt:'2026-09-29T12:00:00Z',snapshotAt:'2026-09-29T11:00:00Z',bytes:1048576,durationMs:2000 },
    lastAttempt:{ startedAt:'2026-10-01T11:00:00Z',finishedAt:null,outcome:'interrupted',phase:'snapshot' } });
  await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('más de 36 horas');
  expect(fixture.nativeElement.textContent).toContain('Interrumpido');
  fixture.nativeElement.querySelector('button').click();
  http.expectOne('/api/admin/backups').flush({}, {status:503,statusText:'Unavailable'});
  await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('no están actualizados');
  expect(fixture.nativeElement.textContent).toContain('1.0 MiB');
  fixture.nativeElement.querySelector('button').click();
  http.expectOne('/api/admin/backups').flush(empty);
  await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  fixture.destroy();
});
