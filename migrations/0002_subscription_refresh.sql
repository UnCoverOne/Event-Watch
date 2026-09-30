ALTER TABLE subscriptions ADD COLUMN check_interval_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE subscriptions ADD COLUMN last_seen_status TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE subscriptions ADD COLUMN next_check_at TEXT;

CREATE INDEX idx_subscriptions_due
ON subscriptions(active, next_check_at);
