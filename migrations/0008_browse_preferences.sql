CREATE TABLE user_browse_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_country_date ON events(country, starts_at, id);
CREATE INDEX idx_stores_country_name ON lgs_stores(country, title COLLATE NOCASE, id);

