-- Cover the due-item subqueries so the scheduler need not scan and
-- sort joined events/stores while selecting only currently due watches.
CREATE INDEX IF NOT EXISTS idx_subscriptions_due_event
  ON subscriptions(active, next_check_at, event_id);
CREATE INDEX IF NOT EXISTS idx_lgs_subscriptions_due_store
  ON lgs_subscriptions(active, next_check_at, store_id);

-- Read unsent notification work in delivery order without sorting the queue.
CREATE INDEX IF NOT EXISTS idx_alert_queue_unsent_created
  ON alert_queue(created_at) WHERE sent_at IS NULL;
