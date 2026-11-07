-- One recoverable object per cache key. Files remain content-addressed.
ALTER TABLE cache_entries
  ADD COLUMN previous_image jsonb,
  ADD COLUMN previous_image_expires_at timestamptz,
  ADD COLUMN rejected_image_hash text,
  ADD COLUMN rejected_image_until timestamptz,
  ADD CONSTRAINT cache_previous_image_pair CHECK (
    (previous_image IS NULL) = (previous_image_expires_at IS NULL)),
  ADD CONSTRAINT cache_previous_image_namespace CHECK (
    previous_image IS NULL OR namespace = 'image');

CREATE INDEX cache_entries_previous_hash_idx ON cache_entries
  ((previous_image->>'contentHash')) WHERE previous_image IS NOT NULL;

-- Reclassify only confirmed static placeholders, never photos or an already
-- classified absence. Wake the existing worker; do not purge objects.
UPDATE cache_entries SET image_last_result = 'placeholder', image_attempts = 0,
  next_refresh_at = now(), revision = revision + 1
WHERE namespace = 'image' AND image_last_result IS DISTINCT FROM 'placeholder'
  AND content_hash IN (
    'cc10b685f33c5f0b9c3599da834a10dc0c30c164b97032e0fa9ef6266cfa5c72',
    '521259c652af6d43cb124876106258d93b6b6f7fbe7ad2c73e8345875afe4dcf',
    '273a4dbd61dfbb0a12d5d8ffe780eb7a3d4d000bc9771c5411cc70ae4dfa8a1f'
  );
