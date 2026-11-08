-- Explicit presentation preference; membership remains the identity authority.
ALTER TABLE canonical_artist_members
  ADD COLUMN preferred_for_navigation boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX canonical_artist_navigation_preference
  ON canonical_artist_members (canonical_artist_id, source_id)
  WHERE preferred_for_navigation;
