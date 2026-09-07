import { createHash } from 'node:crypto';
import type { SourceLyrics } from '../music-source/music-source-adapter.js';
import { CacheRepository } from './cache-repository.js';
import { ObjectStore } from './object-store.js';

export interface RawLyricsDocument {
  content: string;
  contentType: string;
  parserVersion: string;
}

/**
 * Keeps the provider payload needed to reparse lyrics without downloading it
 * again. PostgreSQL only stores the logical key and normalized representation;
 * the regenerable body lives in the configured object store.
 */
export class LyricsObjectCache {
  public constructor(
    private readonly repository: CacheRepository,
    private readonly store: ObjectStore,
  ) {}

  public async put(input: {
    sourceId: string;
    remoteTrackId: string;
    provider: string;
    fingerprint: string;
    raw?: RawLyricsDocument;
    normalized: SourceLyrics;
  }): Promise<{ key: string; parserVersion: string }> {
    const raw = input.raw ?? {
      content: JSON.stringify(input.normalized),
      contentType: 'application/vnd.hirmos.lyrics+json',
      parserVersion: 'normalized-v1',
    };
    const key = createHash('sha256').update([
      input.sourceId, input.remoteTrackId, input.provider, input.fingerprint,
    ].join('\0')).digest('hex');
    const stored = await this.store.put(new TextEncoder().encode(raw.content));
    await this.repository.put({
      namespace: 'lyrics',
      key,
      sourceId: input.sourceId,
      entityType: 'track',
      remoteEntityId: input.remoteTrackId,
      variant: `${input.provider}:${raw.parserVersion}`,
      objectHash: stored.hash,
      relativePath: stored.relativePath,
      contentType: raw.contentType,
      byteLength: stored.byteLength,
    });
    return { key, parserVersion: raw.parserVersion };
  }
}
