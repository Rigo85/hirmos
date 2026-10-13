import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StoredObject {
  hash: string;
  relativePath: string;
  byteLength: number;
}

export interface InventoryObject {
  relativePath: string;
  hash: string | null;
  byteLength: number;
}

export class ObjectStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, 'objects', 'sha256'), { recursive: true }),
      mkdir(join(this.root, 'tmp'), { recursive: true }),
      mkdir(join(this.root, 'quarantine'), { recursive: true }),
    ]);
  }

  public async put(bytes: Uint8Array): Promise<StoredObject> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const relativePath = join('objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash);
    const target = this.path(relativePath);
    try {
      const existing = await stat(target);
      if (existing.isFile() && existing.size === bytes.byteLength) {
        const actual = createHash('sha256').update(await readFile(target)).digest('hex');
        if (actual === hash) return { hash, relativePath, byteLength: bytes.byteLength };
      }
    } catch { /* The content-addressed object is not present yet. */ }

    await mkdir(dirname(target), { recursive: true });
    const temporary = this.path(join('tmp', `${randomUUID()}.part`));
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      try {
        const existing = await stat(target);
        if (!existing.isFile() || existing.size !== bytes.byteLength) throw error;
        await unlink(temporary).catch(() => undefined);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
    return { hash, relativePath, byteLength: bytes.byteLength };
  }

  public async read(relativePath: string, expectedHash?: string): Promise<Uint8Array> {
    const bytes = await readFile(this.path(relativePath));
    if (expectedHash) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expectedHash) throw new Error('Cached object checksum mismatch');
    }
    return bytes;
  }

  public async remove(relativePath: string): Promise<void> {
    // Refuse links in the owned tree, including a linked parent directory.
    const parent = dirname(this.path(relativePath));
    if (await realpath(parent) !== join(await realpath(this.root), dirname(relativePath))) {
      throw new Error('Cache object parent is a symbolic link');
    }
    await unlink(this.path(relativePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  /** Bounded traversal of owned files only. Unknown files count, but are never GC candidates. */
  public async *inventory(): AsyncGenerator<InventoryObject> {
    for (const directory of ['objects', 'tmp', 'quarantine']) {
      yield* this.walk(directory, 0);
    }
  }

  private async *walk(relative: string, depth: number): AsyncGenerator<InventoryObject> {
    const path = join(this.root, relative);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return; // A concurrent atomic publication may have moved a temp file.
    if (info.isSymbolicLink()) throw new Error('Symbolic link in cache inventory');
    if (info.isDirectory()) {
      if (depth > 4) throw new Error('Unexpected cache directory depth');
      const entries = await opendir(path);
      for await (const entry of entries) yield* this.walk(join(relative, entry.name), depth + 1);
      return;
    }
    if (!info.isFile()) return;
    const match = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(relative);
    const hash = match && match[3]!.startsWith(match[1]! + match[2]!) ? match[3]! : null;
    yield { relativePath: relative, hash, byteLength: info.size };
  }

  private path(relativePath: string): string {
    if (!/^(?:objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}|tmp\/[0-9a-f-]+\.part|quarantine\/[0-9a-z.-]+)$/.test(relativePath)) {
      throw new Error('Invalid cache object path');
    }
    const candidate = resolve(this.root, relativePath);
    if (!candidate.startsWith(`${this.root}/`)) throw new Error('Cache object escaped its root');
    return candidate;
  }
}
