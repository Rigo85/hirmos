import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StoredObject {
  hash: string;
  relativePath: string;
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
        return { hash, relativePath, byteLength: bytes.byteLength };
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
    await unlink(this.path(relativePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
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
