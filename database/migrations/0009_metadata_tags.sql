CREATE TABLE metadata_tag_aliases (
  alias_key text PRIMARY KEY,
  canonical_name text NOT NULL,
  category text NOT NULL DEFAULT 'genre'
    CHECK (category IN ('genre', 'era', 'origin', 'descriptor', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metadata_provider_cache (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'album', 'track')),
  remote_entity_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('opensubsonic', 'musicbrainz', 'lastfm')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, entity_type, remote_entity_id, provider)
);

CREATE TABLE metadata_tag_evidence (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'album', 'track')),
  remote_entity_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('opensubsonic', 'musicbrainz', 'lastfm')),
  raw_name text NOT NULL,
  normalized_name text NOT NULL,
  category text NOT NULL
    CHECK (category IN ('genre', 'era', 'origin', 'descriptor', 'unknown')),
  score double precision NOT NULL CHECK (score >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity_type, remote_entity_id, provider, raw_name)
);

CREATE INDEX metadata_tag_evidence_entity
  ON metadata_tag_evidence (source_id, entity_type, remote_entity_id, category, score DESC);

CREATE TABLE resolved_entity_tags (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'album', 'track')),
  remote_entity_id text NOT NULL,
  tag_name text NOT NULL,
  tag_slug text NOT NULL,
  score double precision NOT NULL CHECK (score >= 0),
  rank integer NOT NULL CHECK (rank > 0),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity_type, remote_entity_id, tag_name),
  UNIQUE (source_id, entity_type, remote_entity_id, rank)
);

INSERT INTO metadata_tag_aliases (alias_key, canonical_name) VALUES
  ('alt rock', 'Alternative Rock'),
  ('alt. rock', 'Alternative Rock'),
  ('alternative-rock', 'Alternative Rock'),
  ('alt metal', 'Alternative Metal'),
  ('alt. metal', 'Alternative Metal'),
  ('punk-rock', 'Punk Rock'),
  ('hard-rock', 'Hard Rock'),
  ('prog rock', 'Progressive Rock'),
  ('prog metal', 'Progressive Metal')
ON CONFLICT DO NOTHING;
