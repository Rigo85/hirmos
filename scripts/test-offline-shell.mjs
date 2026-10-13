import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const base = new URL('../apps/web/', import.meta.url);
const read = path => readFile(new URL(path, base), 'utf8');

test('private/live and cross-origin requests bypass the worker unchanged', async () => {
  const listeners = [];
  runInNewContext(await read('public/hirmos-worker.js'), {
    URL,
    self: { location: { origin: 'https://music.example.test' }, addEventListener: (type, fn) => listeners.push([type, fn]) },
    importScripts: path => {
      assert.equal(path, './ngsw-worker.js');
      assert.equal(listeners.length, 1, 'boundary must be registered BEFORE Angular');
    },
  });
  const handler = listeners[0][1];
  for (const path of ['/api/auth/session', '/api/auth/renew', '/api/music/covers/a',
    '/api/music/stream/a', '/api/downloads/a', '/api', '/socket.io/?transport=polling',
    '/health/ready', '/__fixture/tone.wav', 'https://external.example.test/image.jpg']) {
    let stopped = false;
    handler({ request: { url: new URL(path, 'https://music.example.test').href }, stopImmediatePropagation: () => { stopped = true; },
      respondWith() { assert.fail('must not replace the network response'); } });
    assert.equal(stopped, true, path);
  }
  for (const path of ['/local', '/downloads', '/', '/chunk-A.js', '/media/font.woff2']) {
    handler({ request: { url: `https://music.example.test${path}` }, stopImmediatePropagation() { assert.fail(path); } });
  }
});

test('generated manifest precaches every application chunk with matching integrity and no private data', async () => {
  const manifest = JSON.parse(await read('dist/web/browser/ngsw.json'));
  assert.deepEqual(manifest.dataGroups, []);
  assert.equal(manifest.navigationRequestStrategy, 'performance');
  assert.equal(manifest.assetGroups.length, 1);
  const group = manifest.assetGroups[0];
  assert.equal(group.installMode, 'prefetch');
  assert.equal(group.updateMode, 'prefetch');
  assert.deepEqual(group.patterns, []); // only build-time files; no runtime URL cache
  assert(group.urls.includes('/index.html'));
  assert(group.urls.some(url => /\/chunk-.*\.js$/.test(url)), 'include unvisited lazy routes');
  const built = await readdir(new URL('dist/web/browser/', base));
  for (const file of built.filter(file => /^(?:main-|chunk-|styles-).+\.(js|css)$/.test(file))) {
    assert(group.urls.includes(`/${file}`), `not precached: ${file}`);
  }
  for (const path of group.urls) {
    assert(!/^\/(api|socket\.io|health|__fixture)\b/.test(path), path);
    assert(!/worker\.js$|\.map$/.test(path), path);
    const bytes = await readFile(new URL(`dist/web/browser${path}`, base));
    assert.equal(createHash('sha1').update(bytes).digest('hex'), manifest.hashTable[path], path);
  }
  const navigation = path => manifest.navigationUrls.some(rule => rule.positive && new RegExp(rule.regex).test(path)) &&
    !manifest.navigationUrls.some(rule => !rule.positive && new RegExp(rule.regex).test(path));
  for (const path of ['/local', '/downloads', '/albums/synthetic', '/']) assert(navigation(path), path);
  for (const path of ['/api/auth/session', '/socket.io/', '/health/ready', '/__fixture/state', '/missing.js']) assert(!navigation(path), path);
});

test('startup no longer unregisters workers, clears caches or forces reload', async () => {
  const startup = await read('src/main.ts');
  assert(!/unregister|caches\.delete|location\.reload/.test(startup));
  const config = await read('src/app/app.config.ts');
  assert(config.includes("provideServiceWorker('hirmos-worker.js'"));
  assert(config.includes("updateViaCache: 'none'"));
});
