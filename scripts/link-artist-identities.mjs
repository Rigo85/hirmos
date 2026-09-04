import pg from 'pg';

const { Client } = pg;
const databaseUrl = required('DATABASE_URL');
const displayName = required('HIRMOS_CANONICAL_ARTIST_NAME').trim();
const remoteArtistIds = [...new Set(required('HIRMOS_ARTIST_IDS').split(',').map((id) => id.trim()).filter(Boolean))];
if (remoteArtistIds.length < 2) throw new Error('At least two HIRMOS_ARTIST_IDS are required');
const client = new Client({ connectionString: databaseUrl, application_name: 'hirmos-link-artists' });

await client.connect();
try {
  await client.query('BEGIN');
  const source = await client.query(
    `SELECT id FROM music_sources
      WHERE enabled AND ($1::uuid IS NULL OR id = $1::uuid)
      ORDER BY updated_at DESC LIMIT 1`,
    [process.env.HIRMOS_SOURCE_ID?.trim() || null],
  );
  if (!source.rows[0]) throw new Error('Enabled Hirmos music source not found');
  const known = await client.query(
    `SELECT remote_artist_id
       FROM catalog_artists
      WHERE source_id = $1 AND remote_artist_id = ANY($2::text[])
     UNION
     SELECT remote_artist_id
       FROM catalog_tracks
      WHERE source_id = $1 AND remote_artist_id = ANY($2::text[])`,
    [source.rows[0].id, remoteArtistIds],
  );
  if (known.rowCount !== remoteArtistIds.length) {
    throw new Error('Every artist ID must already exist in the Hirmos catalog cache');
  }
  await client.query(
    `INSERT INTO catalog_artists
       (source_id, remote_artist_id, name, cover_art_id, album_count)
     SELECT DISTINCT ON (remote_artist_id)
            source_id, remote_artist_id, artist_name, NULL, 0
       FROM catalog_tracks
      WHERE source_id = $1 AND remote_artist_id = ANY($2::text[])
      ORDER BY remote_artist_id, last_seen_at DESC
     ON CONFLICT (source_id, remote_artist_id) DO NOTHING`,
    [source.rows[0].id, remoteArtistIds],
  );
  const existing = await client.query(
    `SELECT canonical.id
       FROM canonical_artists canonical
       JOIN canonical_artist_members member ON member.canonical_artist_id = canonical.id
      WHERE member.source_id = $1 AND member.remote_artist_id = ANY($2::text[])
      LIMIT 1`,
    [source.rows[0].id, remoteArtistIds],
  );
  const canonical = existing.rows[0] ?? (await client.query(
    'INSERT INTO canonical_artists (display_name) VALUES ($1) RETURNING id',
    [displayName],
  )).rows[0];
  await client.query(
    'UPDATE canonical_artists SET display_name = $1, updated_at = now() WHERE id = $2',
    [displayName, canonical.id],
  );
  await client.query(
    `INSERT INTO canonical_artist_members
       (canonical_artist_id, source_id, remote_artist_id, linked_by)
     SELECT $1, $2, remote_artist_id, 'manual'
       FROM unnest($3::text[]) AS member(remote_artist_id)
     ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
       canonical_artist_id = EXCLUDED.canonical_artist_id,
       linked_by = 'manual'`,
    [canonical.id, source.rows[0].id, remoteArtistIds],
  );
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ status: 'linked', canonicalArtistId: canonical.id, members: remoteArtistIds.length }) + '\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
