import type { AdminMusicSource, SourceCapability } from '@hirmos/contracts';
import type { Database } from '../db/database.js';

export interface StoredMusicSource extends AdminMusicSource {
  credentialCiphertext: Buffer;
  encryptionKeyVersion: number;
}

interface SourceRow {
  id: string;
  name: string;
  base_url: string;
  adapter_type: 'navidrome';
  credential_ciphertext: Buffer;
  encryption_key_version: number;
  enabled: boolean;
  capabilities: SourceCapability[];
  server_version: string | null;
  last_checked_at: Date | null;
  last_synced_at: Date | null;
}

export class MusicSourceRepository {
  public constructor(private readonly db: Database) {}

  public async current(): Promise<StoredMusicSource | null> {
    const result = await this.db.query<SourceRow>(
      `SELECT id, name, base_url, adapter_type, credential_ciphertext,
              encryption_key_version, enabled, capabilities, server_version,
              last_checked_at, last_synced_at
         FROM music_sources
        WHERE enabled
        ORDER BY updated_at DESC
        LIMIT 1`,
    );
    return result.rows[0] ? mapSource(result.rows[0]) : null;
  }

  public async replace(input: {
    name: string;
    baseUrl: string;
    ciphertext: Buffer;
    keyVersion: number;
    capabilities: SourceCapability[];
    serverVersion: string | null;
  }): Promise<StoredMusicSource> {
    const result = await this.db.query<SourceRow>(
      `WITH updated AS (
         UPDATE music_sources
            SET name = $1, base_url = $2, credential_ciphertext = $3,
                encryption_key_version = $4, capabilities = $5::jsonb,
                server_version = $6, last_checked_at = now(), updated_at = now()
          WHERE enabled
         RETURNING id, name, base_url, adapter_type, credential_ciphertext,
                   encryption_key_version, enabled, capabilities, server_version,
                   last_checked_at, last_synced_at
       ), created AS (
         INSERT INTO music_sources
           (name, adapter_type, base_url, credential_ciphertext, encryption_key_version,
            enabled, capabilities, server_version, last_checked_at)
         SELECT $1, 'navidrome', $2, $3, $4, true, $5::jsonb, $6, now()
          WHERE NOT EXISTS (SELECT 1 FROM updated)
         RETURNING id, name, base_url, adapter_type, credential_ciphertext,
                   encryption_key_version, enabled, capabilities, server_version,
                   last_checked_at, last_synced_at
       )
       SELECT * FROM updated
       UNION ALL
       SELECT * FROM created`,
      [
        input.name,
        input.baseUrl,
        input.ciphertext,
        input.keyVersion,
        JSON.stringify(input.capabilities),
        input.serverVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to save music source');
    return mapSource(row);
  }
}

function mapSource(row: SourceRow): StoredMusicSource {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    adapterType: row.adapter_type,
    credentialCiphertext: row.credential_ciphertext,
    encryptionKeyVersion: row.encryption_key_version,
    enabled: row.enabled,
    healthy: row.enabled && Boolean(row.last_checked_at),
    capabilities: row.capabilities,
    serverVersion: row.server_version,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
  };
}
