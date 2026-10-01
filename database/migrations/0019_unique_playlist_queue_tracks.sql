-- Coordinated API/web rollout. The runner executes this migration atomically.
-- Keep queue rows referenced by playback history; only retire duplicate entries.
LOCK TABLE playback_sessions, playlists, playlist_items, queue_items IN ACCESS EXCLUSIVE MODE;

WITH ranked AS (
  SELECT id, playlist_id, row_number() OVER (
    PARTITION BY playlist_id, source_id, remote_track_id ORDER BY ordinal, id) AS n
  FROM playlist_items
), removed AS (
  DELETE FROM playlist_items i USING ranked r WHERE i.id=r.id AND r.n>1
  RETURNING i.playlist_id
)
UPDATE playlists SET revision=revision+1, updated_at=statement_timestamp()
WHERE id IN (SELECT playlist_id FROM removed);

-- Insertion and pagination use dense playlist ordinals (constraint is deferred).
WITH ordered AS (
  SELECT id, (row_number() OVER(PARTITION BY playlist_id ORDER BY ordinal,id)-1)::integer AS ordinal
  FROM playlist_items
)
UPDATE playlist_items i SET ordinal=o.ordinal FROM ordered o WHERE i.id=o.id AND i.ordinal<>o.ordinal;

WITH ranked AS (
  SELECT q.id, q.playback_session_id,
    row_number() OVER (PARTITION BY q.playback_session_id,q.source_id,q.remote_track_id
      ORDER BY (q.id=s.current_queue_item_id) DESC NULLS LAST,q.ordinal,q.id) AS n,
    row_number() OVER (PARTITION BY q.playback_session_id ORDER BY q.ordinal,q.id) AS position
  FROM queue_items q JOIN playback_sessions s ON s.id=q.playback_session_id
  WHERE q.removed_at IS NULL
), removed AS (
  UPDATE queue_items q SET removed_at=statement_timestamp(),priority=false
  FROM ranked r WHERE q.id=r.id AND r.n>1
  RETURNING q.playback_session_id,r.position
), affected AS (
  SELECT s.id,count(*) FILTER(WHERE r.position<=s.queue_past_count)::integer AS removed_past
  FROM playback_sessions s JOIN removed r ON r.playback_session_id=s.id GROUP BY s.id
)
UPDATE playback_sessions s SET queue_past_count=greatest(0,s.queue_past_count-a.removed_past),
  revision=revision+1,queue_revision=queue_revision+1,updated_at=statement_timestamp()
FROM affected a WHERE s.id=a.id;

-- Old undo payloads can contain duplicates even if today's queue has none.
UPDATE playback_sessions SET queue_undo=NULL WHERE queue_undo IS NOT NULL;

CREATE UNIQUE INDEX playlist_unique_track ON playlist_items(playlist_id,source_id,remote_track_id);
CREATE UNIQUE INDEX queue_unique_active_track ON queue_items(playback_session_id,source_id,remote_track_id)
  WHERE removed_at IS NULL;
