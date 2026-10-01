ALTER TABLE queue_items
  ADD COLUMN priority boolean NOT NULL DEFAULT false,
  ADD COLUMN playlist_item_id uuid;

-- Keep source identity after a saved playlist is edited or deleted (no FK).
ALTER TABLE playback_sessions
  ADD COLUMN queue_manually_edited boolean NOT NULL DEFAULT false,
  ADD COLUMN queue_past_count integer NOT NULL DEFAULT 0 CHECK (queue_past_count >= 0),
  ADD COLUMN queue_undo jsonb;
