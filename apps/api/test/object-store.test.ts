import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('counts objects and incomplete/unknown files without treating those as collectible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-object-inventory-'));
    temporaryDirectories.push(root);
    const store = new ObjectStore(root);
    await store.initialize();
    const object = await store.put(new Uint8Array([1, 2, 3]));
    await writeFile(join(root, 'tmp', 'interrupted.part'), '12345');
    const entries = [];
    for await (const entry of store.inventory()) entries.push(entry);
    expect(entries.reduce((total, entry) => total + entry.byteLength, 0)).toBe(8);
    expect(entries.filter(entry => entry.hash).map(entry => entry.hash)).toEqual([object.hash]);
  });

  it('repairs an object even when corrupt bytes have the same length', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-object-corrupt-'));
    temporaryDirectories.push(root);
    const store = new ObjectStore(root);
    await store.initialize();
    const original = new Uint8Array([1, 2, 3]);
    const object = await store.put(original);
    await writeFile(join(root, object.relativePath), new Uint8Array([4, 5, 6]));
    await expect(store.read(object.relativePath, object.hash)).rejects.toThrow('checksum');
    await store.put(original);
    expect(await store.read(object.relativePath, object.hash)).toEqual(Buffer.from(original));
  });

  it('aborts inventory instead of following a symlink outside its tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-object-link-'));
    temporaryDirectories.push(root);
    const store = new ObjectStore(root);
    await store.initialize();
    await symlink(tmpdir(), join(root, 'tmp', 'external'));
    const scan = async () => { for await (const _entry of store.inventory()) { /* inventory only */ } };
    await expect(scan()).rejects.toThrow('Symbolic link');
  });
});
