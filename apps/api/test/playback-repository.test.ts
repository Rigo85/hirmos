import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/database.js';
import { PlaybackRepository } from '../src/playback/playback-repository.js';

describe('PlaybackRepository contextual queues', () => {
  it('appends new ordinals after historical queue rows before replacing the active queue', async () => {
    let contextQuery = '';
    const database = {
      close: vi.fn(async () => undefined),
      query: vi.fn(async (text: string) => {
        if (text.includes('INSERT INTO playback_sessions')) return result([]);
        if (text.trimStart().startsWith('UPDATE playback_sessions')
          && text.includes('SET active_device_id = NULL')) {
          return result([]);
        }
        if (text.includes("'context.selected'")) {
          contextQuery = text;
          return result([{ id: 'checkpoint' }]);
        }
        if (text.includes('SELECT s.id, s.revision::text')) {
          return result([{
            id: 'session', revision: '8', status: 'playing',
            current_queue_item_id: 'current', position_ms: 0,
            position_observed_at: new Date('2026-09-03T00:00:00Z'),
            active_device_id: '22222222-2222-4222-8222-222222222222',
            lease_epoch: '3', lease_expires_at: new Date('2026-09-03T00:01:00Z'),
            source_id: '33333333-3333-4333-8333-333333333333', remote_track_id: 'track-a',
          }]);
        }
        if (text.includes('SELECT q.id, q.source_id')) return result([]);
        throw new Error(`Unexpected query: ${text}`);
      }),
    } as unknown as Database;

    const repository = new PlaybackRepository(database);
    const response = await repository.selectContext({
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      commandId: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 7,
      sourceId: '33333333-3333-4333-8333-333333333333',
      remoteTrackIds: ['track-a', 'track-b'], selectedIndex: 1,
      contextType: 'album', contextRef: 'album-a',
    });

    expect(response.status).toBe('accepted');
    expect(contextQuery).toContain('max(q.ordinal) + 1');
    expect(contextQuery).toContain('OFFSET $7 LIMIT 1');
    expect(contextQuery).not.toContain('WHERE ordinal = $7');
  });

  it('lets play acquire an expired or unowned lease without changing the track', async () => {
    let controlQuery = '';
    const database = {
      close: vi.fn(async () => undefined),
      query: vi.fn(async (text: string) => {
        if (text.includes('INSERT INTO playback_sessions')) return result([]);
        if (text.trimStart().startsWith('UPDATE playback_sessions')
          && text.includes('SET active_device_id = NULL')) {
          return result([]);
        }
        if (text.includes("'playback.controlled'")) {
          controlQuery = text;
          return result([{ id: 'checkpoint' }]);
        }
        if (text.includes('SELECT s.id, s.revision::text')) {
          return result([{
            id: 'session', revision: '9', status: 'playing',
            current_queue_item_id: 'current', position_ms: 12_000,
            position_observed_at: new Date('2026-09-04T00:00:00Z'),
            active_device_id: '22222222-2222-4222-8222-222222222222',
            lease_epoch: '4', lease_expires_at: new Date('2026-09-04T00:01:00Z'),
            source_id: '33333333-3333-4333-8333-333333333333', remote_track_id: 'track-a',
          }]);
        }
        if (text.includes('SELECT q.id, q.source_id')) return result([]);
        throw new Error(`Unexpected query: ${text}`);
      }),
    } as unknown as Database;

    const repository = new PlaybackRepository(database);
    const response = await repository.control({
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      commandId: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 8,
      action: 'play',
    });

    expect(response.status).toBe('accepted');
    expect(controlQuery).toContain("$5 = 'play' OR");
    expect(controlQuery).toContain('active_device_id = CASE');
    expect(controlQuery).toContain("now() + interval '30 seconds'");
  });
});

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}
