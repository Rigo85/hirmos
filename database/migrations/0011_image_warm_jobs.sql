ALTER TABLE background_jobs
  DROP CONSTRAINT background_jobs_kind_check;

ALTER TABLE background_jobs
  ADD CONSTRAINT background_jobs_kind_check
  CHECK (kind IN (
    'catalog_sync', 'metadata_refresh', 'lyrics_upgrade', 'cache_gc', 'image_warm'
  ));

CREATE INDEX background_jobs_image_warm_source
  ON background_jobs ((payload->>'sourceId'), status, available_at, priority DESC, id)
  WHERE kind = 'image_warm';
