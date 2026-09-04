ALTER TABLE user_track_stats
  ADD COLUMN imported_plays integer NOT NULL DEFAULT 0
    CHECK (imported_plays >= 0 AND imported_plays <= qualified_plays);

ALTER TABLE user_track_daily_stats
  ADD COLUMN imported_plays integer NOT NULL DEFAULT 0
    CHECK (imported_plays >= 0 AND imported_plays <= qualified_plays);
