import { fetchEvent } from './adapters.js';
import { nowIso, uuid } from './utils.js';
import { sendAvailabilityEmail } from './email.js';
import { nextCheckAt } from './schedule.js';

export async function runChecks(env) {
  await pruneExpired(env);
  const limit = clampInt(env.CHECK_BATCH_SIZE, 50, 1, 200);
  const concurrency = clampInt(env.CHECK_CONCURRENCY, 5, 1, 10);
  const now = nowIso();

  const result = await env.DB.prepare(`
    SELECT DISTINCT e.*
    FROM events e
    JOIN subscriptions s ON s.event_id = e.id
    WHERE s.active = 1
      AND (s.next_check_at IS NULL OR s.next_check_at <= ?)
    ORDER BY COALESCE(e.last_checked_at, '1970-01-01T00:00:00.000Z') ASC
    LIMIT ?
  `).bind(now, limit).all();

  const events = result.results || [];
  const outcomes = [];
  for (let i = 0; i < events.length; i += concurrency) {
    const chunk = events.slice(i, i + concurrency);
    const chunkOutcomes = await Promise.all(
      chunk.map((event) => checkOneEvent(env, event, { dueAt: now }))
    );
    outcomes.push(...chunkOutcomes);
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

    let notifications = 0;

    for (const subscription of targets) {
      const shouldNotify =
        parsed.status === 'AVAILABLE' &&
        subscription.last_seen_status !== 'AVAILABLE' &&
        Boolean(subscription.email_verified_at);

      let notificationSucceeded = !shouldNotify;

      if (shouldNotify) {
        const notificationId = uuid();
        try {
          const provider = await sendAvailabilityEmail(env, {
            email: subscription.email,
            event: {
              ...event,
              ...parsed,
              title: parsed.title || event.title,
              status_reason: parsed.reason,
            },
            notificationId,
          });

          await env.DB.prepare(`
            INSERT INTO notifications (id, user_id, event_id, kind, status_from, status_to, provider_id, sent_at)
            VALUES (?, ?, ?, 'availability', ?, 'AVAILABLE', ?, ?)
          `).bind(
            notificationId,
            subscription.user_id,
            event.id,
            subscription.last_seen_status || 'UNKNOWN',
            provider?.id || null,
            checkedAt
          ).run();

          notifications++;
          notificationSucceeded = true;
        } catch (error) {
          console.error('Notification failed', event.id, subscription.user_id, error);
          notificationSucceeded = false;
        }
      }

      const preserveForLaterAlert =
        parsed.status === 'AVAILABLE' &&
        subscription.last_seen_status !== 'AVAILABLE' &&
        (!subscription.email_verified_at || !notificationSucceeded);

      await env.DB.prepare(`
        UPDATE subscriptions
        SET last_seen_status = ?,
            next_check_at = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        preserveForLaterAlert ? subscription.last_seen_status : parsed.status,
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
      notifications,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);

    await env.DB.prepare(`
      UPDATE events
      SET last_checked_at = ?,
          last_error = ?,
          consecutive_failures = consecutive_failures + 1,
          updated_at = ?
      WHERE id = ?
    `).bind(checkedAt, message, checkedAt, event.id).run();

    for (const subscription of targets) {
      await env.DB.prepare(`
        UPDATE subscriptions
        SET next_check_at = ?, updated_at = ?
        WHERE id = ?
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

async function getTargetSubscriptions(env, eventId, checkedAt, options) {
  const base = `
    SELECT
      s.id,
      s.user_id,
      s.check_interval_minutes,
      s.last_seen_status,
      s.next_check_at,
      u.email,
      u.email_verified_at
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
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

async function pruneExpired(env) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM email_verifications WHERE expires_at <= ? OR used_at IS NOT NULL').bind(now),
  ]);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
