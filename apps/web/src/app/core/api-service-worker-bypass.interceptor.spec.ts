import { HttpRequest, HttpResponse } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';
import { apiServiceWorkerBypassInterceptor } from './api-service-worker-bypass.interceptor';

describe('apiServiceWorkerBypassInterceptor', () => {
  it('bypasses the service worker for API requests', async () => {
    let forwarded: HttpRequest<unknown> | undefined;
    const request = new HttpRequest('POST', '/api/auth/recovery/complete', {});

    await firstValueFrom(apiServiceWorkerBypassInterceptor(request, (value) => {
      forwarded = value;
      return of(new HttpResponse({ status: 204 }));
    }));

    expect(forwarded?.headers.get('ngsw-bypass')).toBe('true');
  });

  it('does not modify asset requests', async () => {
    let forwarded: HttpRequest<unknown> | undefined;
    const request = new HttpRequest('GET', '/main.js');

    await firstValueFrom(apiServiceWorkerBypassInterceptor(request, (value) => {
      forwarded = value;
      return of(new HttpResponse({ status: 200 }));
    }));

    expect(forwarded?.headers.has('ngsw-bypass')).toBe(false);
  });
});
