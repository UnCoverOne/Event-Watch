-- Additive migration: existing accounts, watches and archives retain their IDs.
ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'uvs';
UPDATE events SET source = 'other' WHERE adapter = 'generic';
ALTER TABLE events ADD COLUMN source_id TEXT;
ALTER TABLE events ADD COLUMN store_id TEXT REFERENCES lgs_stores(id);
ALTER TABLE events ADD COLUMN starts_at TEXT;
ALTER TABLE events ADD COLUMN city TEXT;
ALTER TABLE events ADD COLUMN country TEXT;
ALTER TABLE events ADD COLUMN address TEXT;
ALTER TABLE events ADD COLUMN latitude REAL;
ALTER TABLE events ADD COLUMN longitude REAL;
ALTER TABLE events ADD COLUMN format TEXT;
ALTER TABLE events ADD COLUMN category TEXT;
ALTER TABLE events ADD COLUMN price_minor INTEGER;
ALTER TABLE events ADD COLUMN currency TEXT;
ALTER TABLE events ADD COLUMN description TEXT;
ALTER TABLE events ADD COLUMN fingerprint TEXT;
ALTER TABLE lgs_stores ADD COLUMN source TEXT NOT NULL DEFAULT 'uvs';
ALTER TABLE lgs_stores ADD COLUMN source_id TEXT;
ALTER TABLE lgs_stores ADD COLUMN city TEXT;
ALTER TABLE lgs_stores ADD COLUMN country TEXT;
ALTER TABLE lgs_stores ADD COLUMN address TEXT;
ALTER TABLE lgs_stores ADD COLUMN latitude REAL;
ALTER TABLE lgs_stores ADD COLUMN longitude REAL;
ALTER TABLE lgs_stores ADD COLUMN fingerprint TEXT;
CREATE INDEX idx_events_browse ON events(starts_at, id);
CREATE INDEX idx_events_source_id ON events(source, source_id);
CREATE INDEX idx_events_store ON events(store_id, starts_at);
CREATE INDEX idx_events_fingerprint ON events(fingerprint);
CREATE INDEX idx_stores_fingerprint ON lgs_stores(fingerprint);
CREATE INDEX idx_stores_source_id ON lgs_stores(source, source_id);
CREATE TABLE catalogue_sources (
  kind TEXT NOT NULL CHECK(kind IN ('event', 'store')),
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY(kind, source, source_key)
);
CREATE INDEX idx_catalogue_sources_entity ON catalogue_sources(kind, entity_id);
INSERT INTO catalogue_sources SELECT 'event', source, event_key, id, event_url FROM events;
INSERT INTO catalogue_sources SELECT 'store', source, store_key, id, store_url FROM lgs_stores;
CREATE TABLE catalogue_sync (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  last_checked_at TEXT,
  last_completed_at TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_until TEXT
);
INSERT INTO catalogue_sync (source) VALUES ('uvs-events'), ('uvs-stores'), ('play');
ALTER TABLE subscriptions ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN watching INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN joined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN notify_open INTEGER NOT NULL DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN notify_slots INTEGER NOT NULL DEFAULT 1;
UPDATE subscriptions SET archived = 1 WHERE active = 0;
ALTER TABLE lgs_subscriptions ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lgs_subscriptions ADD COLUMN watching INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lgs_subscriptions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
UPDATE lgs_subscriptions SET archived = 1 WHERE active = 0;
ALTER TABLE alert_queue ADD COLUMN subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE;
ALTER TABLE alert_queue ADD COLUMN store_subscription_id TEXT REFERENCES lgs_subscriptions(id) ON DELETE CASCADE;
UPDATE alert_queue SET subscription_id = (SELECT id FROM subscriptions WHERE alert_queue.item_key LIKE id || ':%') WHERE kind = 'event_available';
UPDATE alert_queue SET store_subscription_id = (SELECT id FROM lgs_subscriptions WHERE alert_queue.item_key LIKE id || ':%') WHERE kind = 'lgs_new_event';
CREATE TRIGGER event_state_updated AFTER UPDATE OF watching, joined, archived ON subscriptions BEGIN
  UPDATE subscriptions SET active = (NEW.watching = 1 AND NEW.joined = 0 AND NEW.archived = 0) WHERE id = NEW.id;
END;
CREATE TRIGGER store_state_updated AFTER UPDATE OF watching, archived ON lgs_subscriptions BEGIN
  UPDATE lgs_subscriptions SET active = (NEW.watching = 1 AND NEW.archived = 0) WHERE id = NEW.id;
END;
CREATE TRIGGER event_alerts_suppressed AFTER UPDATE OF active ON subscriptions WHEN NEW.active = 0 BEGIN
  DELETE FROM alert_queue WHERE sent_at IS NULL AND user_id = NEW.user_id AND (subscription_id = NEW.id OR item_key LIKE NEW.id || ':%');
END;
CREATE TRIGGER store_alerts_suppressed AFTER UPDATE OF active ON lgs_subscriptions WHEN NEW.active = 0 BEGIN
  DELETE FROM alert_queue WHERE sent_at IS NULL AND user_id = NEW.user_id AND (store_subscription_id = NEW.id OR item_key LIKE NEW.id || ':%');
END;
