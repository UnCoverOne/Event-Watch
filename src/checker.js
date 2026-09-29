import { fetchEvent } from './adapters.js';
import { nowIso, uuid } from './utils.js';
import { sendAvailabilityEmail } from './email.js';

export async function runChecks(env) {
  await pruneExpired(env);
  const limit = clampInt(env.CHECK_BATCH_SIZE, 50, 1, 200);
  const concurrency = clampInt(env.CHECK_CONCURRENCY, 5, 1, 10);
  const result = await env.DB.prepare(`
    SELECT e.*
    FROM events e
    WHERE EXISTS (
      SELECT 1 FROM subscriptions s WHERE s.event_id = e.id AND s.active = 1
    )
    ORDER BY COALESCE(e.last_checked_at, '1970-01-01T00:00:00.000Z') ASC
    LIMIT ?
  `).bind(limit).all();

  const events = result.results || [];
  const outcomes = [];
  for (let i = 0; i < events.length; i += concurrency) {
    const chunk = events.slice(i, i + concurrency);
    const chunkOutcomes = await Promise.all(chunk.map((event) => checkOneEvent(env, event)));
    outcomes.push(...chunkOutcomes);
  }
  return outcomes;
}

export async function checkOneEvent(env, event) {
  const previousStatus = event.status || 'UNKNOWN';
  const checkedAt = nowIso();
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
    if (parsed.status === 'AVAILABLE' && previousStatus !== 'AVAILABLE') {
      notifications = await notifySubscribers(env, {
        ...event,
        ...parsed,
        title: parsed.title || event.title,
        status_reason: parsed.reason,
      }, previousStatus);
    }

    return { eventId: event.id, status: parsed.status, previousStatus, notifications };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await env.DB.prepare(`
      UPDATE events SET last_checked_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?
    `).bind(checkedAt, message, checkedAt, event.id).run();
    console.error('Event check failed', event.event_key, message);
    return { eventId: event.id, status: previousStatus, error: message };
  }
}

async function notifySubscribers(env, event, previousStatus) {
  const rows = await env.DB.prepare(`
    SELECT u.id AS user_id, u.email, u.email_verified_at
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    WHERE s.event_id = ? AND s.active = 1
  `).bind(event.id).all();

  let sent = 0;
  for (const user of rows.results || []) {
    if (!user.email_verified_at) continue;
    const notificationId = uuid();
    try {
      const provider = await sendAvailabilityEmail(env, {
        email: user.email,
        event,
        notificationId,
      });
      await env.DB.prepare(`
        INSERT INTO notifications (id, user_id, event_id, kind, status_from, status_to, provider_id, sent_at)
        VALUES (?, ?, ?, 'availability', ?, 'AVAILABLE', ?, ?)
      `).bind(notificationId, user.user_id, event.id, previousStatus, provider?.id || null, nowIso()).run();
      sent++;
    } catch (error) {
      console.error('Notification failed', event.id, user.user_id, error);
    }
  }
  return sent;
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
