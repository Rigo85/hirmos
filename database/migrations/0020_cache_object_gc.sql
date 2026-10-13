-- First observed without a reference, not object creation time: replacing an
-- old cover must not make its old bytes eligible for immediate deletion.
CREATE TABLE cache_object_gc (
  object_hash text PRIMARY KEY CHECK (object_hash ~ '^[0-9a-f]{64}$'),
  first_unreferenced_at timestamptz NOT NULL DEFAULT now()
);
