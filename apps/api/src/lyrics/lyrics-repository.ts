import type { Database } from '../db/database.js';
import type { SourceLyrics } from '../music-source/music-source-adapter.js';

interface CacheRow {
  status: 'found' | 'not_found';
  display_artist: string | null;
  display_title: string | null;
  language: string | null;
  synced: boolean;
  lines: Array<{ startMs: number | null; text: string }>;
}

export class LyricsRepository {
  public constructor(private readonly db: Database) {}

  public async get(input: {
    sourceId: string; remoteTrackId: string; provider: string; fingerprint: string;
  }): Promise<SourceLyrics[] | null | undefined> {
    const result = await this.db.query<CacheRow>(
      `SELECT status, display_artist, display_title, language, synced, lines
         FROM lyrics_cache
        WHERE source_id = $1 AND remote_track_id = $2 AND provider = $3
          AND lookup_fingerprint = $4 AND expires_at > now()
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

  public async put(input: {
    sourceId: string;
    remoteTrackId: string;
    provider: string;
    fingerprint: string;
    providerItemId?: string | null;
    instrumental?: boolean;
    document: SourceLyrics | null;
  }): Promise<void> {
    const document = input.document;
    await this.db.query(
      `INSERT INTO lyrics_cache
         (source_id, remote_track_id, provider, provider_item_id, lookup_fingerprint,
          display_artist, display_title, language, synced, instrumental, lines,
          status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
               now() + CASE WHEN $12 = 'found' THEN interval '30 days' ELSE interval '6 hours' END)
       ON CONFLICT (source_id, remote_track_id, provider, lookup_fingerprint) DO UPDATE SET
         provider_item_id = EXCLUDED.provider_item_id,
         display_artist = EXCLUDED.display_artist,
         display_title = EXCLUDED.display_title,
         language = EXCLUDED.language,
         synced = EXCLUDED.synced,
         instrumental = EXCLUDED.instrumental,
         lines = EXCLUDED.lines,
         status = EXCLUDED.status,
         fetched_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [input.sourceId, input.remoteTrackId, input.provider, input.providerItemId ?? null,
       input.fingerprint, document?.displayArtist ?? null, document?.displayTitle ?? null,
       document?.language ?? null, document?.synced ?? false, input.instrumental ?? false,
       JSON.stringify(document?.lines ?? []), document ? 'found' : 'not_found'],
    );
  }
}
