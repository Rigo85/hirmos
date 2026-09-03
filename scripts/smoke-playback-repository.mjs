import { randomUUID } from 'node:crypto';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { ActivityRepository } from '../apps/api/dist/activity/activity-repository.js';
import { PlaybackRepository } from '../apps/api/dist/playback/playback-repository.js';
import { PlaybackService } from '../apps/api/dist/playback/playback-service.js';
import { encodeTrackReference } from '../apps/api/dist/music-source/track-reference.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = createDatabase(databaseUrl);
let userId;
let sourceId;
try {
  userId = (await db.query(
    `INSERT INTO users (email, display_name, role) VALUES ($1, 'Playback smoke', 'user') RETURNING id`,
    [`playback-smoke-${randomUUID()}@example.invalid`],
  )).rows[0].id;
  sourceId = (await db.query(
    `INSERT INTO music_sources
       (name, adapter_type, base_url, credential_ciphertext, encryption_key_version,
        enabled, capabilities)
     VALUES ('Smoke source', 'navidrome', 'https://example.invalid', decode('00','hex'), 1,
             true, '[]'::jsonb) RETURNING id`,
  )).rows[0].id;
  const deviceId = randomUUID();
  const service = new PlaybackService(new PlaybackRepository(db), new ActivityRepository(db));
  await service.registerDevice({ userId, deviceId, name: 'Smoke', type: 'desktop' });
  const initial = await service.snapshot(userId);
  const tracks = ['one', 'two', 'three'].map((id) => encodeTrackReference(sourceId, id));
  const selected = await service.selectContext({
    userId, deviceId, commandId: randomUUID(), expectedRevision: initial.revision,
    trackRefs: tracks, selectedIndex: 1, contextType: 'album', contextRef: 'album:smoke',
  });
  if (selected.status !== 'accepted' || selected.snapshot.queue.length !== 3
      || selected.snapshot.currentTrackRef !== tracks[1]) {
    throw new Error('Context selection did not create the expected queue');
  }
  const moved = await service.control({
    userId, deviceId, commandId: randomUUID(), expectedRevision: selected.snapshot.revision,
    action: 'next', reason: 'ended',
  });
  if (moved.status !== 'accepted' || moved.snapshot.currentTrackRef !== tracks[2]) {
    throw new Error('Context queue did not advance');
  }
  const telemetry = await db.query(
    `SELECT
       (SELECT count(*)::int FROM listen_events WHERE user_id = $1) AS events,
       (SELECT count(*)::int FROM user_track_stats WHERE user_id = $1) AS stats,
       (SELECT count(*)::int FROM user_track_stats WHERE user_id = $1 AND completions = 1) AS completions`,
    [userId],
  );
  if (telemetry.rows[0].events !== 3 || telemetry.rows[0].stats !== 2
      || telemetry.rows[0].completions !== 1) {
    throw new Error(`Unexpected telemetry: ${JSON.stringify(telemetry.rows[0])}`);
  }
  process.stdout.write(JSON.stringify({ status: 'ok', queue: 3, ...telemetry.rows[0] }) + '\n');
} finally {
  if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
  if (sourceId) await db.query('DELETE FROM music_sources WHERE id = $1', [sourceId]);
  await db.close();
}
