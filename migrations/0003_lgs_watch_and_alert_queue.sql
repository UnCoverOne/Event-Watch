CREATE TABLE lgs_stores (
  id TEXT PRIMARY KEY,
  store_key TEXT NOT NULL UNIQUE,
  store_url TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT 'riftbound-store',
  source_host TEXT,
  title TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_lgs_stores_last_checked_at ON lgs_stores(last_checked_at);

CREATE TABLE lgs_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  check_interval_minutes INTEGER NOT NULL DEFAULT 5,
  next_check_at TEXT,
  initialized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, store_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES lgs_stores(id) ON DELETE CASCADE
);
CREATE INDEX idx_lgs_subscriptions_due ON lgs_subscriptions(active, next_check_at);
CREATE INDEX idx_lgs_subscriptions_user ON lgs_subscriptions(user_id, active);

CREATE TABLE lgs_subscription_events (
  subscription_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_url TEXT NOT NULL,
  title TEXT,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, event_key),
  FOREIGN KEY (subscription_id) REFERENCES lgs_subscriptions(id) ON DELETE CASCADE
);

CREATE TABLE alert_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  title TEXT NOT NULL,
  item_url TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(user_id, kind, item_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_alert_queue_unsent ON alert_queue(sent_at, user_id, created_at);
