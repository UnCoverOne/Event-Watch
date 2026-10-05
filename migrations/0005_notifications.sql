ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alert_queue ADD COLUMN email_sent_at TEXT;
UPDATE alert_queue SET email_sent_at = sent_at WHERE sent_at IS NOT NULL;
CREATE TABLE push_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_jwk TEXT NOT NULL
);
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, enabled);
CREATE TABLE push_deliveries (
  alert_id TEXT NOT NULL REFERENCES alert_queue(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (alert_id, subscription_id)
);
ALTER TABLE alert_queue ADD COLUMN detail_url TEXT;
CREATE TABLE notification_delivery_locks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
