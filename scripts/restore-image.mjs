// Restore one inspected cache key, without consulting an external provider.
// Dry-run by default. DATABASE_URL and HIRMOS_CACHE_DIR come from the environment.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { ImageCacheService, imageKey } from '../apps/api/dist/cache/image-cache-service.js';
import { validateImage } from '../apps/api/dist/cache/image-validator.js';
import { KNOWN_IMAGE_PLACEHOLDERS } from '../apps/api/dist/cache/image-refresh-policy.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, cover: { type: 'string' }, size: { type: 'string', default: '320' },
  apply: { type: 'boolean', default: false }, 'expected-current-hash': { type: 'string' },
  preview: { type: 'string' },
} });
assert.ok(values.source && values.cover, 'Supply --source and --cover with exact IDs');
assert.ok([128, 320, 640].includes(Number(values.size)), 'Unsupported size');
const { DATABASE_URL, HIRMOS_CACHE_DIR } = process.env;
assert.ok(DATABASE_URL && HIRMOS_CACHE_DIR, 'Configure database and cache directory');
assert.match(new URL(DATABASE_URL).pathname, /^\/hirmos(?:[_-][a-zA-Z0-9_-]+)?$/);
if (values.apply) assert.match(values['expected-current-hash'] ?? '', /^[0-9a-f]{64}$/);
const db = createDatabase(DATABASE_URL);
try {
  const repository = new CacheRepository(db), store = new ObjectStore(HIRMOS_CACHE_DIR);
  const input = { sourceId: values.source, remoteId: values.cover, size: Number(values.size) };
  const entry = await repository.get('image', imageKey(input.sourceId, input.remoteId, input.size));
  assert.ok(entry?.previousImage && entry.previousImageExpiresAt > new Date(), 'No unexpired previous image');
  assert.ok(!KNOWN_IMAGE_PLACEHOLDERS.has(entry.previousImage.contentHash), 'Previous image is a known placeholder');
  const bytes = await store.read(entry.previousImage.relativePath, entry.previousImage.contentHash);
  await validateImage(bytes);
  if (values.preview) await writeFile(values.preview, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ size: input.size, currentHash: entry.contentHash,
    previousHash: entry.previousImage.contentHash, expires: entry.previousImageExpiresAt, apply: values.apply }));
  if (values.apply) {
    const cache = new ImageCacheService(repository, store);
    assert.ok(await cache.restorePrevious(input, values['expected-current-hash']),
      'Entry changed or previous image is no longer usable; inspect again');
    console.log(JSON.stringify({ restored: true, rejectedCandidateDays: 30 }));
  }
} finally { await db.close(); }
