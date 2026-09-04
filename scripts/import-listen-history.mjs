import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = required('DATABASE_URL');
const userEmail = required('HIRMOS_HISTORY_USER_EMAIL').trim().toLowerCase();
const provider = required('HIRMOS_HISTORY_PROVIDER').trim();
const inputFile = required('HIRMOS_HISTORY_FILE');
const rows = parseRows(await readFile(inputFile, 'utf8'));
const client = new Client({ connectionString: databaseUrl, application_name: 'hirmos-history-import' });

await client.connect();
try {
  await client.query('BEGIN');
  const user = await client.query('SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL', [userEmail]);
  if (!user.rows[0]) throw new Error('Active Hirmos user not found');
  const source = await client.query(
    `SELECT id FROM music_sources
      WHERE enabled AND ($1::uuid IS NULL OR id = $1::uuid)
      ORDER BY updated_at DESC LIMIT 1`,
    [process.env.HIRMOS_HISTORY_SOURCE_ID?.trim() || null],
  );
  if (!source.rows[0]) throw new Error('Enabled Hirmos music source not found');

  const inserted = await client.query(
    `WITH input AS (
       SELECT item->>'externalEventId' AS external_event_id,
              item->>'remoteTrackId' AS remote_track_id,
              (item->>'occurredAt')::timestamptz AS occurred_at
         FROM jsonb_array_elements($4::jsonb) AS item
     )
     INSERT INTO imported_listens
       (user_id, source_id, provider, external_event_id, remote_track_id, occurred_at)
     SELECT $1, $2, $3, external_event_id, remote_track_id, occurred_at
       FROM input
     ON CONFLICT (user_id, source_id, provider, external_event_id) DO NOTHING
     RETURNING remote_track_id, occurred_at`,
    [user.rows[0].id, source.rows[0].id, provider, JSON.stringify(rows)],
  );

  const aggregates = aggregate(inserted.rows);
  if (aggregates.length) {
    await client.query(
      `WITH imported AS (
         SELECT item->>'remoteTrackId' AS remote_track_id,
                (item->>'statDate')::date AS stat_date,
                (item->>'qualifiedPlays')::integer AS qualified_plays,
                (item->>'firstPlayedAt')::timestamptz AS first_played_at,
                (item->>'lastPlayedAt')::timestamptz AS last_played_at
           FROM jsonb_array_elements($3::jsonb) AS item
       ), lifetime AS (
         INSERT INTO user_track_stats
           (user_id, source_id, remote_track_id, qualified_plays, imported_plays,
            first_played_at, last_played_at, last_observed_at)
         SELECT $1, $2, remote_track_id, SUM(qualified_plays)::integer,
                SUM(qualified_plays)::integer,
                MIN(first_played_at), MAX(last_played_at), now()
           FROM imported GROUP BY remote_track_id
         ON CONFLICT (user_id, source_id, remote_track_id) DO UPDATE SET
           qualified_plays = user_track_stats.qualified_plays + EXCLUDED.qualified_plays,
           imported_plays = user_track_stats.imported_plays + EXCLUDED.imported_plays,
           first_played_at = LEAST(user_track_stats.first_played_at, EXCLUDED.first_played_at),
           last_played_at = GREATEST(user_track_stats.last_played_at, EXCLUDED.last_played_at),
           last_observed_at = now()
         RETURNING 1
       )
       INSERT INTO user_track_daily_stats
         (user_id, source_id, remote_track_id, stat_date, qualified_plays, imported_plays,
          first_played_at, last_played_at)
       SELECT $1, $2, remote_track_id, stat_date, qualified_plays, qualified_plays,
              first_played_at, last_played_at
         FROM imported
       ON CONFLICT (user_id, source_id, remote_track_id, stat_date) DO UPDATE SET
         qualified_plays = user_track_daily_stats.qualified_plays + EXCLUDED.qualified_plays,
         imported_plays = user_track_daily_stats.imported_plays + EXCLUDED.imported_plays,
         first_played_at = LEAST(user_track_daily_stats.first_played_at,
                                 EXCLUDED.first_played_at),
         last_played_at = GREATEST(user_track_daily_stats.last_played_at,
                                  EXCLUDED.last_played_at)`,
      [user.rows[0].id, source.rows[0].id, JSON.stringify(aggregates)],
    );
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    status: 'imported', submitted: rows.length, inserted: inserted.rowCount, duplicates: rows.length - inserted.rowCount,
  }) + '\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

function parseRows(content) {
  const seen = new Set();
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1}`); }
    const externalEventId = String(value.externalEventId ?? '').trim();
    const remoteTrackId = String(value.remoteTrackId ?? '').trim();
    const occurredAt = new Date(value.occurredAt);
    if (!externalEventId || externalEventId.length > 500) throw new Error(`Invalid externalEventId on line ${index + 1}`);
    if (!remoteTrackId || remoteTrackId.length > 500) throw new Error(`Invalid remoteTrackId on line ${index + 1}`);
    if (Number.isNaN(occurredAt.valueOf())) throw new Error(`Invalid occurredAt on line ${index + 1}`);
    if (seen.has(externalEventId)) throw new Error(`Duplicate externalEventId in input on line ${index + 1}`);
    seen.add(externalEventId);
    return { externalEventId, remoteTrackId, occurredAt: occurredAt.toISOString() };
  });
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const occurredAt = new Date(row.occurred_at).toISOString();
    const statDate = occurredAt.slice(0, 10);
    const key = `${row.remote_track_id}\u0000${statDate}`;
    const current = groups.get(key) ?? {
      remoteTrackId: row.remote_track_id,
      statDate,
      qualifiedPlays: 0,
      firstPlayedAt: occurredAt,
      lastPlayedAt: occurredAt,
    };
    current.qualifiedPlays++;
    if (occurredAt < current.firstPlayedAt) current.firstPlayedAt = occurredAt;
    if (occurredAt > current.lastPlayedAt) current.lastPlayedAt = occurredAt;
    groups.set(key, current);
  }
  return [...groups.values()];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
