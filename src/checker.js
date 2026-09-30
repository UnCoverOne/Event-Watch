import { fetchEvent, fetchLgsStore } from './adapters.js';
import { nowIso, uuid } from './utils.js';
import { sendWatchDigestEmail } from './email.js';
import { nextCheckAt } from './schedule.js';

export async function runChecks(env) {
  await pruneExpired(env);
  const dueAt = nowIso();
  const eventOutcomes = await runEventChecks(env, dueAt);
  const lgsOutcomes = await runLgsChecks(env, dueAt);
  const delivery = await flushAlertQueue(env);
  return { eventOutcomes, lgsOutcomes, delivery };
}

async function runEventChecks(env, dueAt) {
  const limit = clampInt(env.CHECK_BATCH_SIZE, 50, 1, 200);
  const concurrency = clampInt(env.CHECK_CONCURRENCY, 5, 1, 10);
  const result = await env.DB.prepare(`
    SELECT DISTINCT e.*
    FROM events e
    JOIN subscriptions s ON s.event_id = e.id
    WHERE s.active = 1
      AND (s.next_check_at IS NULL OR s.next_check_at <= ?)
    ORDER BY COALESCE(e.last_checked_at, '1970-01-01T00:00:00.000Z') ASC
    LIMIT ?
  `).bind(dueAt, limit).all();

  return runInChunks(result.results || [], concurrency, (event) =>
    checkOneEvent(env, event, { dueAt })
  );
}

async function runLgsChecks(env, dueAt) {
  const limit = clampInt(env.CHECK_BATCH_SIZE, 50, 1, 200);
  const concurrency = clampInt(env.CHECK_CONCURRENCY, 5, 1, 10);
  const result = await env.DB.prepare(`
    SELECT DISTINCT s.*
    FROM lgs_stores s
    JOIN lgs_subscriptions sub ON sub.store_id = s.id
    WHERE sub.active = 1
      AND (sub.next_check_at IS NULL OR sub.next_check_at <= ?)
    ORDER BY COALESCE(s.last_checked_at, '1970-01-01T00:00:00.000Z') ASC
    LIMIT ?
  `).bind(dueAt, limit).all();

  return runInChunks(result.results || [], concurrency, (store) =>
    checkOneLgs(env, store, { dueAt })
  );
}

async function runInChunks(items, concurrency, worker) {
  const outcomes = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    outcomes.push(...await Promise.all(chunk.map(worker)));
  }
  return outcomes;
}

export async function checkOneEvent(env, event, options = {}) {
  const checkedAt = nowIso();
  const targets = await getTargetSubscriptions(env, event.id, checkedAt, options);

  if (!targets.length) {
    return { eventId: event.id, skipped: true, reason: 'No subscriptions are due.' };
  }

  const previousStatus = event.status || 'UNKNOWN';

  try {
    const parsed = await fetchEvent(event);
    const changed = previousStatus !== parsed.status;
    const changedAt = changed ? checkedAt : (event.last_changed_at || null);

    await env.DB.prepare(`
      UPDATE events SET
        title = COALESCE(?, title),
        status = ?,
        status_reason = ?,
        current_players = ?,
        capacity = ?,
        last_checked_at = ?,
        last_changed_at = ?,
        last_error = NULL,
        consecutive_failures = 0,
        updated_at = ?
      WHERE id = ?
    `).bind(
      parsed.title,
      parsed.status,
      parsed.reason,
      parsed.currentPlayers,
      parsed.capacity,
      checkedAt,
      changedAt,
      checkedAt,
      event.id
    ).run();

    let alertsQueued = 0;
    for (const subscription of targets) {
      if (parsed.status === 'AVAILABLE' && subscription.last_seen_status !== 'AVAILABLE') {
        const inserted = await enqueueAlert(env, {
          userId: subscription.user_id,
          kind: 'event_available',
          itemKey: `${subscription.id}:${event.id}:${checkedAt}`,
          title: parsed.title || event.title || 'Watched event',
          itemUrl: event.event_url,
          message: parsed.reason || 'Registration or booking appears to be available.',
          createdAt: checkedAt,
        });
        if (inserted) alertsQueued++;
      }

      await env.DB.prepare(`
        UPDATE subscriptions
        SET last_seen_status = ?, next_check_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        parsed.status,
        nextCheckAt(checkedAt, subscription.check_interval_minutes),
        checkedAt,
        subscription.id
      ).run();
    }

    return {
      eventId: event.id,
      status: parsed.status,
      previousStatus,
      subscriptionsChecked: targets.length,
      alertsQueued,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);

    await env.DB.prepare(`
      UPDATE events
      SET last_checked_at = ?, last_error = ?,
          consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?
    `).bind(checkedAt, message, checkedAt, event.id).run();

    for (const subscription of targets) {
      await env.DB.prepare(`
        UPDATE subscriptions SET next_check_at = ?, updated_at = ? WHERE id = ?
      `).bind(
        nextCheckAt(checkedAt, subscription.check_interval_minutes),
        checkedAt,
        subscription.id
      ).run();
    }

    console.error('Event check failed', event.event_key, message);
    return {
      eventId: event.id,
      status: previousStatus,
      subscriptionsChecked: targets.length,
      error: message,
    };
  }
}

export async function checkOneLgs(env, store, options = {}) {
  const checkedAt = nowIso();
  const targets = await getTargetLgsSubscriptions(env, store.id, checkedAt, options);

  if (!targets.length) {
    return { storeId: store.id, skipped: true, reason: 'No LGS subscriptions are due.' };
  }

  try {
    const snapshot = await fetchLgsStore(store);
    const storeTitle = snapshot.title || store.title || 'Watched LGS';

    await env.DB.prepare(`
      UPDATE lgs_stores SET
        title = COALESCE(?, title),
        last_checked_at = ?,
        last_error = NULL,
        consecutive_failures = 0,
        updated_at = ?
      WHERE id = ?
    `).bind(snapshot.title, checkedAt, checkedAt, store.id).run();

    let alertsQueued = 0;
    let newEventsFound = 0;

    for (const subscription of targets) {
      const seenResult = await env.DB.prepare(`
        SELECT event_key FROM lgs_subscription_events WHERE subscription_id = ?
      `).bind(subscription.id).all();
      const seen = new Set((seenResult.results || []).map((row) => row.event_key));
      const unseen = snapshot.events.filter((event) => !seen.has(event.eventKey));
      const initializing = !subscription.initialized_at;

      for (const event of unseen) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO lgs_subscription_events
            (subscription_id, event_key, event_url, title, first_seen_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          subscription.id,
          event.eventKey,
          event.eventUrl,
          event.title,
          checkedAt
        ).run();

        if (!initializing) {
          newEventsFound++;
          const inserted = await enqueueAlert(env, {
            userId: subscription.user_id,
            kind: 'lgs_new_event',
            itemKey: `${subscription.id}:${event.eventKey}`,
            title: event.title || `Riftbound event #${event.eventKey}`,
            itemUrl: event.eventUrl,
            message: `New event added to ${storeTitle}.`,
            createdAt: checkedAt,
          });
          if (inserted) alertsQueued++;
        }
      }

      await env.DB.prepare(`
        UPDATE lgs_subscriptions
        SET initialized_at = COALESCE(initialized_at, ?),
            next_check_at = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        checkedAt,
        nextCheckAt(checkedAt, subscription.check_interval_minutes),
        checkedAt,
        subscription.id
      ).run();
    }

    return {
      storeId: store.id,
      title: storeTitle,
      subscriptionsChecked: targets.length,
      listedEvents: snapshot.events.length,
      newEventsFound,
      alertsQueued,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);

    await env.DB.prepare(`
      UPDATE lgs_stores
      SET last_checked_at = ?, last_error = ?,
          consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?
    `).bind(checkedAt, message, checkedAt, store.id).run();

    for (const subscription of targets) {
      await env.DB.prepare(`
        UPDATE lgs_subscriptions SET next_check_at = ?, updated_at = ? WHERE id = ?
      `).bind(
        nextCheckAt(checkedAt, subscription.check_interval_minutes),
        checkedAt,
        subscription.id
      ).run();
    }

    console.error('LGS check failed', store.store_key, message);
    return { storeId: store.id, subscriptionsChecked: targets.length, error: message };
  }
}

export async function flushAlertQueue(env, options = {}) {
  const userId = options.userId || null;
  const whereUser = userId ? ' AND q.user_id = ?' : '';
  const statement = env.DB.prepare(`
    SELECT
      q.id, q.user_id, q.kind, q.item_key, q.title,
      q.item_url, q.message, q.created_at,
      u.email, u.email_verified_at
    FROM alert_queue q
    JOIN users u ON u.id = q.user_id
    WHERE q.sent_at IS NULL${whereUser}
    ORDER BY q.created_at ASC
    LIMIT 500
  `);
  const result = userId ? await statement.bind(userId).all() : await statement.all();
  const groups = groupAlertsByUser(result.results || []);

  let emailsSent = 0;
  let alertsSent = 0;
  let failures = 0;

  for (const group of groups) {
    if (!group.email_verified_at) continue;

    try {
      await sendWatchDigestEmail(env, {
        email: group.email,
        alerts: group.alerts,
      });

      const sentAt = nowIso();
      await env.DB.batch(group.alerts.map((alert) =>
        env.DB.prepare('UPDATE alert_queue SET sent_at = ? WHERE id = ? AND sent_at IS NULL')
          .bind(sentAt, alert.id)
      ));
      emailsSent++;
      alertsSent += group.alerts.length;
    } catch (error) {
      failures++;
      console.error('Digest notification failed', group.user_id, error);
    }
  }

  return { emailsSent, alertsSent, failures };
}

export function groupAlertsByUser(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    if (!groups.has(row.user_id)) {
      groups.set(row.user_id, {
        user_id: row.user_id,
        email: row.email,
        email_verified_at: row.email_verified_at,
        alerts: [],
      });
    }
    groups.get(row.user_id).alerts.push(row);
  }

  return [...groups.values()];
}

async function enqueueAlert(env, alert) {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO alert_queue
      (id, user_id, kind, item_key, title, item_url, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    uuid(),
    alert.userId,
    alert.kind,
    alert.itemKey,
    String(alert.title || 'Event Watch update').slice(0, 300),
    alert.itemUrl,
    alert.message || null,
    alert.createdAt || nowIso()
  ).run();

  return Number(result.meta?.changes || 0) > 0;
}

async function getTargetSubscriptions(env, eventId, checkedAt, options) {
  const base = `
    SELECT
      s.id, s.user_id, s.check_interval_minutes,
      s.last_seen_status, s.next_check_at
    FROM subscriptions s
    WHERE s.event_id = ? AND s.active = 1
  `;

  if (options.subscriptionId) {
    const row = await env.DB.prepare(base + ' AND s.id = ?')
      .bind(eventId, options.subscriptionId)
      .first();
    return row ? [row] : [];
  }

  const dueAt = options.dueAt || checkedAt;
  const rows = await env.DB.prepare(
    base + ' AND (s.next_check_at IS NULL OR s.next_check_at <= ?)'
  ).bind(eventId, dueAt).all();
  return rows.results || [];
}

async function getTargetLgsSubscriptions(env, storeId, checkedAt, options) {
  const base = `
    SELECT
      s.id, s.user_id, s.check_interval_minutes,
      s.next_check_at, s.initialized_at
    FROM lgs_subscriptions s
    WHERE s.store_id = ? AND s.active = 1
  `;

  if (options.subscriptionId) {
    const row = await env.DB.prepare(base + ' AND s.id = ?')
      .bind(storeId, options.subscriptionId)
      .first();
    return row ? [row] : [];
  }

  const dueAt = options.dueAt || checkedAt;
  const rows = await env.DB.prepare(
    base + ' AND (s.next_check_at IS NULL OR s.next_check_at <= ?)'
  ).bind(storeId, dueAt).all();
  return rows.results || [];
}

async function pruneExpired(env) {
  const now = nowIso();
  const sentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM email_verifications WHERE expires_at <= ? OR used_at IS NOT NULL').bind(now),
    env.DB.prepare('DELETE FROM alert_queue WHERE sent_at IS NOT NULL AND sent_at <= ?').bind(sentCutoff),
  ]);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
