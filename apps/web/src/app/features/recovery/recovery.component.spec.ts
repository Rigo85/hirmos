import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { RecoveryComponent } from './recovery.component';

describe('RecoveryComponent', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [RecoveryComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => 'x'.repeat(43) } } },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    }).compileComponents();
  });

  it('explains the minimum password length without sending a request', () => {
    const fixture = TestBed.createComponent(RecoveryComponent);
    fixture.detectChanges();
    fill(fixture.nativeElement.querySelector('#password'), 'corta');
    fill(fixture.nativeElement.querySelector('#confirm-password'), 'corta');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Debe tener al menos 12 caracteres.');
    TestBed.inject(HttpTestingController).expectNone('/api/auth/recovery/complete');
  });

  it('shows Retry-After feedback for a 429 response', async () => {
    const fixture = TestBed.createComponent(RecoveryComponent);
    fixture.detectChanges();
    fill(fixture.nativeElement.querySelector('#password'), 'contraseña-segura-2026');
    fill(fixture.nativeElement.querySelector('#confirm-password'), 'contraseña-segura-2026');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    const request = TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/recovery/complete');
    request.flush({}, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '120' },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Vuelve a probar en 2 minutos.');
  });
});

function fill(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
