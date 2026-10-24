-- Refresh attempts are separate from the last usable image. No object is
-- removed when a provider temporarily fails or returns a generic avatar.
ALTER TABLE cache_entries
  ADD COLUMN revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN image_last_result text CHECK (image_last_result IN ('image', 'placeholder', 'error')),
  ADD COLUMN image_attempts integer NOT NULL DEFAULT 0 CHECK (image_attempts >= 0),
  ADD COLUMN image_checked_at timestamptz;

-- Recognized legacy generic avatar (exact bytes, not file-size heuristics).
UPDATE cache_entries SET next_refresh_at = now()
 WHERE namespace = 'image'
   AND content_hash = 'cc10b685f33c5f0b9c3599da834a10dc0c30c164b97032e0fa9ef6266cfa5c72';
