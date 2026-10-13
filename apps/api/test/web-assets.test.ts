import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

it('does not substitute the SPA HTML for missing worker, manifest or application chunks', async () => {
  const app = await buildApp({config: loadConfig({NODE_ENV:'test', PUBLIC_ORIGIN:'http://localhost:4200'}), logger:false});
  try {
    for (const url of ['/absent-worker.js', '/missing-version.json', '/chunk-missing.js?ngsw-cache-bust=test', '/styles-missing.css']) {
      const response = await app.inject({url});
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).not.toContain('text/html');
    }
  } finally { await app.close(); }
});
