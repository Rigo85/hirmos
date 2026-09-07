import type { Database } from '../db/database.js';
import type { SourceLyrics } from '../music-source/music-source-adapter.js';
import { createHash } from 'node:crypto';

interface CacheRow {
  status: 'found' | 'not_found';
  display_artist: string | null;
  display_title: string | null;
  language: string | null;
  synced: boolean;
  lines: SourceLyrics['lines'];
}

export interface LyricsWithoutObject {
  sourceId: string;
  remoteTrackId: string;
  provider: string;
  fingerprint: string;
  document: SourceLyrics;
}

export class LyricsRepository {
  public constructor(private readonly db: Database) {}

  public async getAdjustment(
    userId: string,
    sourceId: string,
    remoteTrackId: string,
  ): Promise<number> {
    const result = await this.db.query<{ adjustment_ms: number }>(
      `SELECT adjustment_ms
         FROM user_lyrics_adjustments
        WHERE user_id = $1 AND source_id = $2 AND remote_track_id = $3`,
      [userId, sourceId, remoteTrackId],
    );
    return result.rows[0]?.adjustment_ms ?? 0;
  }

  public async putAdjustment(input: {
    userId: string;
    sourceId: string;
    remoteTrackId: string;
    adjustmentMs: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO user_lyrics_adjustments
         (user_id, source_id, remote_track_id, adjustment_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, source_id, remote_track_id) DO UPDATE SET
         adjustment_ms = EXCLUDED.adjustment_ms,
         updated_at = now()`,
      [input.userId, input.sourceId, input.remoteTrackId, input.adjustmentMs],
    );
  }

  public async get(input: {
    sourceId: string; remoteTrackId: string; provider: string; fingerprint: string;
  }): Promise<SourceLyrics[] | null | undefined> {
    const result = await this.db.query<CacheRow>(
      `SELECT status, display_artist, display_title, language, synced, lines
         FROM lyrics_cache
        WHERE source_id = $1 AND remote_track_id = $2 AND provider = $3
          AND lookup_fingerprint = $4
          AND (status = 'found' OR expires_at > now())
        ORDER BY fetched_at DESC LIMIT 1`,
      [input.sourceId, input.remoteTrackId, input.provider, input.fingerprint],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.status === 'not_found') return null;
    return [{
      displayArtist: row.display_artist,
      displayTitle: row.display_title,
      language: row.language,
      synced: row.synced,
      lines: row.lines,
    }];
  }

  public async getStaleFound(input: {
    sourceId: string; remoteTrackId: string; provider: string; fingerprint: string;
  }): Promise<SourceLyrics[] | undefined> {
    const result = await this.db.query<CacheRow>(
      `SELECT status, display_artist, display_title, language, synced, lines
         FROM lyrics_cache
        WHERE source_id = $1 AND remote_track_id = $2 AND provider = $3
          AND lookup_fingerprint = $4 AND status = 'found'
        ORDER BY fetched_at DESC LIMIT 1`,
      [input.sourceId, input.remoteTrackId, input.provider, input.fingerprint],
    );
    const row = result.rows[0];
    return row ? [{
      displayArtist: row.display_artist,
      displayTitle: row.display_title,
      language: row.language,
      synced: row.synced,
      lines: row.lines,
    }] : undefined;
  }

  public async put(input: {
    sourceId: string;
    remoteTrackId: string;
    provider: string;
    fingerprint: string;
    providerItemId?: string | null;
    instrumental?: boolean;
    rawObjectKey?: string | null;
    parserVersion?: string | null;
    document: SourceLyrics | null;
  }): Promise<void> {
    const document = input.document;
    const quality = lyricsQuality(document);
    const contentHash = document
      ? createHash('sha256').update(JSON.stringify(document)).digest('hex')
      : null;
    await this.db.query(
      `INSERT INTO lyrics_cache
         (source_id, remote_track_id, provider, provider_item_id, lookup_fingerprint,
          display_artist, display_title, language, synced, instrumental, lines,
          status, expires_at, quality, raw_object_key, parser_version, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
               now() + CASE WHEN $12 = 'found' THEN interval '100 years' ELSE interval '7 days' END,
               $13, $14, $15, $16)
       ON CONFLICT (source_id, remote_track_id, provider, lookup_fingerprint) DO UPDATE SET
         provider_item_id = EXCLUDED.provider_item_id,
         display_artist = EXCLUDED.display_artist,
         display_title = EXCLUDED.display_title,
         language = EXCLUDED.language,
         synced = EXCLUDED.synced,
         instrumental = EXCLUDED.instrumental,
         lines = EXCLUDED.lines,
         status = EXCLUDED.status,
         quality = EXCLUDED.quality,
         raw_object_key = COALESCE(EXCLUDED.raw_object_key, lyrics_cache.raw_object_key),
         parser_version = EXCLUDED.parser_version,
         content_hash = EXCLUDED.content_hash,
         fetched_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [input.sourceId, input.remoteTrackId, input.provider, input.providerItemId ?? null,
       input.fingerprint, document?.displayArtist ?? null, document?.displayTitle ?? null,
       document?.language ?? null, document?.synced ?? false, input.instrumental ?? false,
       JSON.stringify(document?.lines ?? []), document ? 'found' : 'not_found', quality,
       input.rawObjectKey ?? null, input.parserVersion ?? 'normalized-v1', contentHash],
    );
  }

  public async withoutRawObject(limit: number): Promise<LyricsWithoutObject[]> {
    const result = await this.db.query<CacheRow & {
      source_id: string; remote_track_id: string; provider: string; lookup_fingerprint: string;
    }>(
      `SELECT source_id, remote_track_id, provider, lookup_fingerprint,
              status, display_artist, display_title, language, synced, lines
         FROM lyrics_cache
        WHERE status = 'found' AND raw_object_key IS NULL
        ORDER BY id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      remoteTrackId: row.remote_track_id,
      provider: row.provider,
      fingerprint: row.lookup_fingerprint,
      document: {
        displayArtist: row.display_artist,
        displayTitle: row.display_title,
        language: row.language,
        synced: row.synced,
        lines: row.lines,
      },
    }));
  }

  public async attachRawObject(input: {
    sourceId: string;
    remoteTrackId: string;
    provider: string;
    fingerprint: string;
    rawObjectKey: string;
    parserVersion: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE lyrics_cache SET raw_object_key = $5, parser_version = $6
        WHERE source_id = $1 AND remote_track_id = $2 AND provider = $3
          AND lookup_fingerprint = $4 AND status = 'found' AND raw_object_key IS NULL`,
      [input.sourceId, input.remoteTrackId, input.provider, input.fingerprint,
       input.rawObjectKey, input.parserVersion],
    );
  }
}

function lyricsQuality(document: SourceLyrics | null): 'plain' | 'line' | 'word' {
  if (!document) return 'plain';
  if (document.lines.some((line) => line.words?.length)) return 'word';
  if (document.synced || document.lines.some((line) => line.startMs !== null)) return 'line';
  return 'plain';
}
