-- Informational provenance only: editing/deleting either collection never
-- mutates the other. Existing entries deliberately remain unmapped.
ALTER TABLE playlist_items ADD COLUMN origin_queue_item_id uuid;
