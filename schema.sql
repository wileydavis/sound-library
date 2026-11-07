-- Sound Library catalog. Apply with:
--   npx wrangler d1 execute sound-library --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  recorded_at     TEXT,            -- ISO date (YYYY-MM-DD) or datetime
  title           TEXT NOT NULL,
  type            TEXT NOT NULL,   -- field | voice | ir | tonal | other
  tags            TEXT DEFAULT '', -- comma-separated, lowercase
  description     TEXT DEFAULT '',
  location        TEXT DEFAULT '',
  lat             REAL,
  lon             REAL,
  location_words  TEXT DEFAULT '', -- the four spoken location words
  people          TEXT DEFAULT '', -- comma-separated names
  release_status  TEXT DEFAULT '', -- '' | none | verbal | written | n/a
  notes           TEXT DEFAULT '',
  slate           TEXT DEFAULT '',
  transcript      TEXT DEFAULT '',
  transcript_json TEXT DEFAULT '', -- [{start,end,text}]
  filename        TEXT NOT NULL,   -- clip filename
  clip_key        TEXT NOT NULL,
  original_key    TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  sha256          TEXT,
  sample_rate     INTEGER,
  channels        INTEGER,
  bit_depth       INTEGER,
  duration        REAL,            -- clip duration, seconds
  original_duration REAL,
  peak_db         REAL,
  lufs            REAL,
  noise_floor_db  REAL,
  processing      TEXT DEFAULT '{}',  -- JSON of options applied
  source_meta     TEXT DEFAULT '{}',  -- JSON: bext / iXML fields from the original
  peaks           TEXT DEFAULT '',    -- base64 int8 min/max pairs for waveform
  clip_size       INTEGER,
  original_size   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS items_sha ON items(sha256);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at);
CREATE INDEX IF NOT EXISTS items_type ON items(type);
CREATE INDEX IF NOT EXISTS items_latlon ON items(lat, lon);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, tags, description, location, people, notes, slate, transcript, filename,
  content='items', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, tags, description, location, people, notes, slate, transcript, filename)
  VALUES (new.rowid, new.title, new.tags, new.description, new.location, new.people, new.notes, new.slate, new.transcript, new.filename);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, tags, description, location, people, notes, slate, transcript, filename)
  VALUES ('delete', old.rowid, old.title, old.tags, old.description, old.location, old.people, old.notes, old.slate, old.transcript, old.filename);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, tags, description, location, people, notes, slate, transcript, filename)
  VALUES ('delete', old.rowid, old.title, old.tags, old.description, old.location, old.people, old.notes, old.slate, old.transcript, old.filename);
  INSERT INTO items_fts(rowid, title, tags, description, location, people, notes, slate, transcript, filename)
  VALUES (new.rowid, new.title, new.tags, new.description, new.location, new.people, new.notes, new.slate, new.transcript, new.filename);
END;
