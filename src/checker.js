import { catalogueStoreEvents } from './catalogue.js';
import { sendPush, alertNotification } from './push.js';
import { fetchEvent, fetchLgsStore } from './adapters.js';
import { nowIso, uuid } from './utils.js';
import { sendWatchDigestEmail } from './email.js';
import { nextCheckAt } from './schedule.js';
import { fetchPlayStoreEvents } from './sources.js';

export async function runChecks(env) {
  const dueAt = nowIso();
  // Expired rows are never treated as valid; physical cleanup only needs to
  // run hourly instead of on every five-minute watch pass.
  if (new Date(dueAt).getUTCMinutes() === 0) await pruneExpired(env);
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
        event_date = COALESCE(?, event_date),
        host_lgs = COALESCE(?, host_lgs),
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
      parsed.eventDate ?? null,
      parsed.hostLgs ?? null,
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
      if (shouldNotifyAvailability(subscription, parsed.status)) {
        const inserted = await enqueueAlert(env, {
          userId: subscription.user_id,
          kind: 'event_available',
          subscriptionId: subscription.id,
          itemKey: `${subscription.id}:${event.id}:${checkedAt}`,
          title: parsed.title || event.title || 'Watched event',
          itemUrl: event.event_url,
          detailUrl: `/detail.html?kind=event&id=${encodeURIComponent(event.id)}`,
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
        parsed.status === 'UNKNOWN' ? subscription.last_seen_status : parsed.status,
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
    let snapshot;
    if (store.source === 'play') {
      snapshot = await fetchPlayStoreEvents(store);
    } else if (store.source_id) {
      const events = await catalogueStoreEvents(env, store, { refresh: store.source === 'uvs' });
      snapshot = {
        title: store.title,
        events: events.map((e) => ({
          eventKey: store.source === 'uvs'
            ? e.event_key.replace(/^riftbound:/, '')
            : e.event_key,
          eventUrl: e.event_url,
          title: e.title,
        })),
      };
    } else snapshot = await fetchLgsStore(store);
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
            storeSubscriptionId: subscription.id,
            itemKey: `${subscription.id}:${event.eventKey}`,
            title: event.title || `Riftbound event #${event.eventKey}`,
            itemUrl: event.eventUrl,
            detailUrl: `/detail.html?kind=lgs&id=${encodeURIComponent(store.id)}`,
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
  const statement = env.DB.prepare(`
    SELECT q.*, u.email, u.email_verified_at, u.email_notifications
    FROM alert_queue q JOIN users u ON u.id = q.user_id
    WHERE q.sent_at IS NULL${userId ? ' AND q.user_id = ?' : ''}
    ORDER BY q.created_at ASC LIMIT 500
  `);
  const result = userId ? await statement.bind(userId).all() : await statement.all();
  let emailsSent = 0, pushesSent = 0, alertsSent = 0, failures = 0;
  for (const group of groupAlertsByUser(result.results || [])) {
    const lockToken = uuid();
    const locked = await env.DB.prepare(`INSERT INTO notification_delivery_locks (user_id, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE notification_delivery_locks.expires_at <= ?`).bind(group.user_id, lockToken, new Date(Date.now() + 10 * 60_000).toISOString(), nowIso()).run();
    if (!locked.meta?.changes) continue;
    try {
      // Refresh inside the lease: another flush may have completed these rows.
      group.alerts = (await env.DB.prepare('SELECT * FROM alert_queue WHERE user_id = ? AND sent_at IS NULL ORDER BY created_at LIMIT 100').bind(group.user_id).all()).results || [];

      const eligible = [];
      for (const alert of group.alerts) {
        if (await alertIsEligible(env, alert)) eligible.push(alert);
        else await env.DB.prepare('DELETE FROM alert_queue WHERE id = ?').bind(alert.id).run();
      }
      group.alerts = eligible;
      const emailPending = group.alerts.filter(a => !a.email_sent_at);
      let emailComplete = !group.email_notifications || !emailPending.length;
      if (!emailComplete && group.email_verified_at) {
        try {
          await sendWatchDigestEmail(env, { email: group.email, alerts: emailPending });
          await env.DB.batch(emailPending.map(a => env.DB.prepare('UPDATE alert_queue SET email_sent_at = ? WHERE id = ?').bind(nowIso(), a.id)));
          emailsSent++; emailComplete = true;
        } catch (error) { failures++; console.error('Email notification failed', group.user_id, error); }
      }
      const subs = (await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND enabled = 1').bind(group.user_id).all()).results || [];
      for (const alert of group.alerts) {
        let pushComplete = true;
        for (const sub of subs) {
          // Do not deliver old queued events to a newly enabled device.
          if (sub.created_at > alert.created_at) continue;
          const delivered = await env.DB.prepare('SELECT sent_at FROM push_deliveries WHERE alert_id = ? AND subscription_id = ?').bind(alert.id, sub.id).first();
          if (delivered) continue;
          try {
            const sent = await sendPush(env, sub, alertNotification(alert));
            if (sent) {
              await env.DB.prepare('INSERT OR IGNORE INTO push_deliveries (alert_id, subscription_id, sent_at) VALUES (?, ?, ?)').bind(alert.id, sub.id, nowIso()).run();
              pushesSent++;
            }
          } catch (error) { pushComplete = false; failures++; console.error('Push notification failed', sub.id, error); }
        }
        if (emailComplete && pushComplete) {
          await env.DB.prepare('UPDATE alert_queue SET sent_at = ? WHERE id = ? AND sent_at IS NULL').bind(nowIso(), alert.id).run();
          alertsSent++;
        }
      }
    } finally {
      await env.DB.prepare('DELETE FROM notification_delivery_locks WHERE user_id = ? AND token = ?').bind(group.user_id, lockToken).run();
    }
  }
  return { emailsSent, pushesSent, alertsSent, failures };
}

export function groupAlertsByUser(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    if (!groups.has(row.user_id)) {
      groups.set(row.user_id, {
        user_id: row.user_id,
        email: row.email,
        email_verified_at: row.email_verified_at,
        email_notifications: row.email_notifications,
        alerts: [],
      });
    }
    groups.get(row.user_id).alerts.push(row);
  }

  return [...groups.values()];
}

export function shouldNotifyAvailability(subscription, status) {
  if (status !== 'AVAILABLE' || subscription.last_seen_status === 'AVAILABLE') return false;
  return subscription.last_seen_status === 'FULL' ? subscription.notify_slots !== 0 : subscription.notify_open !== 0;
}

export async function alertIsEligible(env, alert) {
  const row = await env.DB.prepare(`SELECT
    (? IS NULL OR EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ? AND active = 1))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM lgs_subscriptions WHERE id = ? AND user_id = ? AND active = 1))
    AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN events e ON e.id = s.event_id
      WHERE s.user_id = ? AND (s.joined = 1 OR s.archived = 1)
      AND (e.event_url = ? OR EXISTS (SELECT 1 FROM catalogue_sources cs WHERE cs.kind = 'event' AND cs.entity_id = e.id AND cs.url = ?))) AS eligible`)
    .bind(alert.subscription_id ?? null, alert.subscription_id ?? null, alert.user_id,
      alert.store_subscription_id ?? null, alert.store_subscription_id ?? null, alert.user_id,
      alert.user_id, alert.item_url, alert.item_url).first();
  return Boolean(row?.eligible);
}

async function enqueueAlert(env, alert) {
  if (!await alertIsEligible(env, { subscription_id: alert.subscriptionId, store_subscription_id: alert.storeSubscriptionId, user_id: alert.userId, item_url: alert.itemUrl })) return false;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO alert_queue
      (id, user_id, kind, item_key, title, item_url, message, created_at, detail_url, subscription_id, store_subscription_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    uuid(),
    alert.userId,
    alert.kind,
    alert.itemKey,
    String(alert.title || 'Event Watch update').slice(0, 300),
    alert.itemUrl,
    alert.message || null,
    alert.createdAt || nowIso(),
    alert.detailUrl || null,
    alert.subscriptionId || null,
    alert.storeSubscriptionId || null
  ).run();

  return Number(result.meta?.changes || 0) > 0;
}

async function getTargetSubscriptions(env, eventId, checkedAt, options) {
  const base = `
    SELECT
      s.id, s.user_id, s.check_interval_minutes,
      s.last_seen_status, s.next_check_at, s.notify_open, s.notify_slots
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
