import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectStore } from '../src/cache/object-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('ObjectStore', () => {
  it('stores equal content once and validates its checksum when reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-object-cache-'));
    temporaryDirectories.push(root);
    const store = new ObjectStore(root);
    await store.initialize();
    const bytes = new Uint8Array([10, 20, 30]);

    const first = await store.put(bytes);
    const second = await store.put(bytes);

    expect(second).toEqual(first);
    expect(await store.read(first.relativePath, first.hash)).toEqual(Buffer.from(bytes));
    await expect(store.read('../outside')).rejects.toThrow('Invalid cache object path');
  });
});
