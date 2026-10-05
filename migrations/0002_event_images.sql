-- Event photos, copied from each event's Google Drive photo folder (the
-- Logic Engine's "Photo Folder ID") by the n8n workflow "RTD Event Images".
-- The bytes live in Workers KV (binding IMAGES, key img:<image_id>); this
-- table records which photos belong to which event, in display order.

CREATE TABLE event_images (
  event_id     TEXT NOT NULL REFERENCES events (event_id),
  source       TEXT NOT NULL CHECK (source IN ('drive')),
  source_id    TEXT NOT NULL,          -- Google Drive file id
  source_name  TEXT,                   -- file name, for people reading the table
  sort         INTEGER NOT NULL DEFAULT 0,
  image_id     TEXT,                   -- first 32 hex of the SHA-256 of the bytes; NULL until uploaded
  content_type TEXT,
  bytes        INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (event_id, source, source_id)
);

CREATE INDEX event_images_by_image ON event_images (image_id);
