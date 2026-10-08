-- Prevent manual source imports from being repeated with different visitor scopes.
CREATE TABLE catalogue_manual_refresh (
  key TEXT PRIMARY KEY,
  next_allowed_at TEXT NOT NULL
);
INSERT INTO catalogue_manual_refresh (key, next_allowed_at) VALUES ('global', '1970-01-01T00:00:00.000Z');

-- Country-scoped browsing and location discovery.
CREATE INDEX IF NOT EXISTS idx_events_country_city_date ON events(country, city, starts_at);
CREATE INDEX IF NOT EXISTS idx_stores_country_city ON lgs_stores(country, city);

-- Exact case-insensitive store lookup used during catalogue reconciliation.
CREATE INDEX IF NOT EXISTS idx_stores_title_nocase ON lgs_stores(title COLLATE NOCASE);

-- Source-scoped catalogue queries.
CREATE INDEX IF NOT EXISTS idx_catalogue_sources_kind_source_entity ON catalogue_sources(kind, source, entity_id);

-- Frequent event filter values benefit from a country-first access path.
CREATE INDEX IF NOT EXISTS idx_events_country_format ON events(country, format);
CREATE INDEX IF NOT EXISTS idx_events_country_category ON events(country, category);
