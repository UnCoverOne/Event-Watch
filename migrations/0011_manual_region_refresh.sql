-- Refreshes progress through UVS pages per selected region, never in the background.
CREATE TABLE catalogue_region_cursors (
  source TEXT NOT NULL CHECK(source IN ('uvs-events', 'uvs-stores')),
  country TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  next_page INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_completed_at TEXT,
  PRIMARY KEY (source, country, city)
);
