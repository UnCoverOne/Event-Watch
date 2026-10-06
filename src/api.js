import { handleNotifications } from './notifications.js';
import {
  assertSameOrigin,
  clearSessionCookie,
  currentUser,
  issueVerification,
  login,
  logout,
  register,
  requireUser,
  verifyEmailToken,
} from './auth.js';
import { checkOneEvent, checkOneLgs, flushAlertQueue } from './checker.js';
import { normalizeEventUrl, normalizeLgsUrl, fetchLgsStore, fetchEvent } from './adapters.js';
import { normalizeCheckInterval, nextCheckAt } from './schedule.js';
import { HttpError, json, nowIso, readJson, uuid } from './utils.js';

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'GET' && url.pathname === '/api/health') {
    return json({ ok: true, service: env.APP_NAME || 'Event Watch' });
  }

  if (method === 'GET' && url.pathname === '/api/auth/verify-email') {
    await verifyEmailToken(env, url.searchParams.get('token'));
    const target = new URL('/', request.url);
    target.searchParams.set('verified', '1');
    return Response.redirect(target.toString(), 302);
  }

  if (['POST', 'DELETE', 'PATCH'].includes(method)) assertSameOrigin(request);

  if (url.pathname === '/api/settings/notifications' || url.pathname.startsWith('/api/push/')) {
    return handleNotifications(request, env);
  }

  if (method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson(request);
    const result = await register({ ...request, json: async () => body, url: request.url }, env);
    return json({ user: result.user, verificationSent: result.verificationSent }, 201, { 'set-cookie': result.cookie });
  }

  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(request);
    const result = await login(body, env);
    return json({ user: result.user }, 200, { 'set-cookie': result.cookie });
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    await logout(request, env);
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    const user = await currentUser(request, env);
    return json({ user });
  }

  if (method === 'POST' && url.pathname === '/api/auth/resend-verification') {
    const user = await requireUser(request, env);
    if (user.emailVerified) return json({ ok: true, alreadyVerified: true });
    await issueVerification(env, user, new URL(request.url).origin);
    await flushAlertQueue(env, { userId: user.id });
    return json({ ok: true });
  }

  if (method === 'GET' && url.pathname === '/api/events') {
    const user = await requireUser(request, env);
    const rows = await env.DB.prepare(`
      SELECT
        s.id AS subscription_id,
        s.check_interval_minutes,
        s.next_check_at,
        s.active,
        e.id AS event_id,
        e.event_key,
        e.event_url,
        e.adapter,
        e.source_host,
        e.title,
        e.event_date,
        e.host_lgs,
        e.status,
        e.status_reason,
        e.current_players,
        e.capacity,
        e.last_checked_at,
        e.last_changed_at,
        e.last_error,
        e.consecutive_failures,
        s.created_at
      FROM subscriptions s
      JOIN events e ON e.id = s.event_id
      WHERE s.user_id = ?
      ORDER BY s.active DESC, s.created_at DESC
    `).bind(user.id).all();
    return json({ events: rows.results || [] });
  }

  if (method === 'POST' && url.pathname === '/api/events') {
    const user = await requireUser(request, env);
    const body = await readJson(request);
    const checkIntervalMinutes = normalizeCheckInterval(body.checkIntervalMinutes);

    let parsed;
    try {
      parsed = await normalizeEventUrl(body.url);
    } catch (error) {
      throw new HttpError(400, error.message, 'invalid_event_url');
    }

    const at = nowIso();
    let event = await env.DB.prepare('SELECT * FROM events WHERE event_key = ?').bind(parsed.eventKey).first();

    if (!event) {
      const eventId = uuid();
      await env.DB.prepare(`
        INSERT INTO events (id, event_key, event_url, adapter, source_host, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'UNKNOWN', ?, ?)
      `).bind(eventId, parsed.eventKey, parsed.canonicalUrl, parsed.adapter, parsed.sourceHost, at, at).run();
      event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    }

    const existing = await env.DB.prepare(
      'SELECT id, active FROM subscriptions WHERE user_id = ? AND event_id = ?'
    ).bind(user.id, event.id).first();

    let subscriptionId;
    if (existing) {
      subscriptionId = existing.id;
      await env.DB.prepare(`
        UPDATE subscriptions
        SET active = 1,
            check_interval_minutes = ?,
            last_seen_status = 'UNKNOWN',
            next_check_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).bind(checkIntervalMinutes, at, existing.id).run();
    } else {
      subscriptionId = uuid();
      await env.DB.prepare(`
        INSERT INTO subscriptions (
          id, user_id, event_id, active, check_interval_minutes,
          last_seen_status, next_check_at, created_at, updated_at
        )
        VALUES (?, ?, ?, 1, ?, 'UNKNOWN', NULL, ?, ?)
      `).bind(subscriptionId, user.id, event.id, checkIntervalMinutes, at, at).run();
    }

    await checkOneEvent(env, event, { subscriptionId });
    await flushAlertQueue(env, { userId: user.id });

    const refreshed = await env.DB.prepare(`
      SELECT s.id AS subscription_id, s.check_interval_minutes, s.next_check_at, e.*
      FROM subscriptions s
      JOIN events e ON e.id = s.event_id
      WHERE s.id = ?
    `).bind(subscriptionId).first();

    return json({ event: refreshed }, 201);
  }

  if (method === 'GET' && url.pathname === '/api/lgs') {
    const user = await requireUser(request, env);
    const rows = await env.DB.prepare(`
      SELECT
        sub.id AS subscription_id,
        sub.check_interval_minutes,
        sub.next_check_at,
        sub.initialized_at,
        sub.active,
        store.id AS store_id,
        store.store_key,
        store.store_url,
        store.adapter,
        store.source_host,
        store.title,
        store.last_checked_at,
        store.last_error,
        store.consecutive_failures,
        (
          SELECT COUNT(*) FROM lgs_subscription_events seen
          WHERE seen.subscription_id = sub.id
        ) AS known_event_count,
        sub.created_at
      FROM lgs_subscriptions sub
      JOIN lgs_stores store ON store.id = sub.store_id
      WHERE sub.user_id = ?
      ORDER BY sub.active DESC, sub.created_at DESC
    `).bind(user.id).all();
    return json({ stores: rows.results || [] });
  }

  const lgsEventMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)\/events\/(\d+)$/);
  if (method === 'GET' && lgsEventMatch) {
    const user = await requireUser(request, env);
    const store = await env.DB.prepare(`SELECT store.*, sub.id AS subscription_id
      FROM lgs_stores store JOIN lgs_subscriptions sub ON sub.store_id = store.id
      WHERE sub.user_id = ? AND store.id = ?`).bind(user.id, decodeURIComponent(lgsEventMatch[1])).first();
    if (!store) throw new HttpError(404, 'This LGS watch could not be found.');
    const key = lgsEventMatch[2];
    let listed = await env.DB.prepare('SELECT title FROM lgs_subscription_events WHERE subscription_id = ? AND event_key = ?').bind(store.subscription_id, key).first();
    if (!listed) {
      const snapshot = await fetchLgsStore(store);
      listed = snapshot.events.find(event => event.eventKey === key);
    }
    if (!listed) throw new HttpError(404, 'This event is not listed at this LGS.');
    const watched = await env.DB.prepare(`SELECT e.*, e.id AS event_id, s.id AS subscription_id, s.active,
      s.check_interval_minutes, s.next_check_at, s.created_at
      FROM events e JOIN subscriptions s ON s.event_id = e.id
      WHERE s.user_id = ? AND e.event_key = ?`).bind(user.id, `riftbound:${key}`).first();
    if (watched) return json({ event: { ...watched, is_watched: true } });
    const eventUrl = `https://locator.riftbound.uvsgames.com/events/${key}`;
    const item = { event_key: `riftbound:${key}`, event_url: eventUrl, adapter: 'riftbound',
      source_host: 'locator.riftbound.uvsgames.com', title: listed.title, host_lgs: store.title,
      is_watched: false, status: 'UNKNOWN' };
    try {
      const parsed = await fetchEvent(item);
      Object.assign(item, { title: parsed.title || item.title, status: parsed.status,
        status_reason: parsed.reason, event_date: parsed.eventDate, host_lgs: parsed.hostLgs || store.title,
        current_players: parsed.currentPlayers, capacity: parsed.capacity, last_checked_at: nowIso() });
    } catch { item.last_error = 'Current event details could not be loaded. You can retry by reopening this event.'; }
    return json({ event: item });
  }

  const lgsEventsMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)\/events$/);
  if (method === 'GET' && lgsEventsMatch) {
    const user = await requireUser(request, env);
    const store = await env.DB.prepare(`
      SELECT store.*, sub.id AS subscription_id
      FROM lgs_stores store JOIN lgs_subscriptions sub ON sub.store_id = store.id
      WHERE sub.user_id = ? AND store.id = ?
    `).bind(user.id, decodeURIComponent(lgsEventsMatch[1])).first();
    if (!store) throw new HttpError(404, 'This LGS watch could not be found.');
    const saved = (await env.DB.prepare(`
      SELECT event_key, event_url, title, first_seen_at
      FROM lgs_subscription_events WHERE subscription_id = ?
      ORDER BY first_seen_at DESC, event_key DESC
    `).bind(store.subscription_id).all()).results || [];
    try {
      // Reading a listing must not change the monitoring baseline or suppress alerts.
      const snapshot = await fetchLgsStore(store);
      const savedTitles = new Map(saved.map(event => [event.event_key, event.title]));
      return json({ events: snapshot.events.map(event => ({
        event_key: event.eventKey, event_url: event.eventUrl,
        title: event.title || savedTitles.get(event.eventKey) || `Riftbound event #${event.eventKey}`,
      })), source: 'live', fetchedAt: nowIso() });
    } catch {
      return json({ events: saved, source: 'saved', fetchedAt: store.last_checked_at,
        warning: 'The current store listing could not be loaded. Showing events saved from previous checks.' });
    }
  }

  if (method === 'POST' && url.pathname === '/api/lgs') {
    const user = await requireUser(request, env);
    const body = await readJson(request);
    const checkIntervalMinutes = normalizeCheckInterval(body.checkIntervalMinutes);

    let parsed;
    try {
      parsed = normalizeLgsUrl(body.url);
    } catch (error) {
      throw new HttpError(400, error.message, 'invalid_lgs_url');
    }

    const at = nowIso();
    let store = await env.DB.prepare('SELECT * FROM lgs_stores WHERE store_key = ?')
      .bind(parsed.storeKey).first();

    if (!store) {
      const storeId = uuid();
      await env.DB.prepare(`
        INSERT INTO lgs_stores
          (id, store_key, store_url, adapter, source_host, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        storeId,
        parsed.storeKey,
        parsed.canonicalUrl,
        parsed.adapter,
        parsed.sourceHost,
        at,
        at
      ).run();
      store = await env.DB.prepare('SELECT * FROM lgs_stores WHERE id = ?').bind(storeId).first();
    }

    const existing = await env.DB.prepare(`
      SELECT id FROM lgs_subscriptions WHERE user_id = ? AND store_id = ?
    `).bind(user.id, store.id).first();

    let subscriptionId;
    if (existing) {
      subscriptionId = existing.id;
      await env.DB.prepare(`
        UPDATE lgs_subscriptions
        SET active = 1,
            check_interval_minutes = ?,
            next_check_at = NULL,
            initialized_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).bind(checkIntervalMinutes, at, existing.id).run();
    } else {
      subscriptionId = uuid();
      await env.DB.prepare(`
        INSERT INTO lgs_subscriptions
          (id, user_id, store_id, active, check_interval_minutes, next_check_at, initialized_at, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, NULL, NULL, ?, ?)
      `).bind(subscriptionId, user.id, store.id, checkIntervalMinutes, at, at).run();
    }

    const result = await checkOneLgs(env, store, { subscriptionId });

    const refreshed = await getLgsSubscription(env, user.id, store.id);
    return json({ store: refreshed, result }, 201);
  }

  const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
  if (method === 'PATCH' && eventMatch) {
    const user = await requireUser(request, env);
    const eventId = eventMatch[1];
    const body = await readJson(request);
    const checkIntervalMinutes = parseRequestedInterval(body.checkIntervalMinutes);

    const subscription = await env.DB.prepare(`
      SELECT id FROM subscriptions
      WHERE user_id = ? AND event_id = ? AND active = 1
    `).bind(user.id, eventId).first();
    if (!subscription) throw new HttpError(404, 'Event not found.', 'not_found');

    const at = nowIso();
    const next = nextCheckAt(at, checkIntervalMinutes);
    await env.DB.prepare(`
      UPDATE subscriptions
      SET check_interval_minutes = ?, next_check_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(checkIntervalMinutes, next, at, subscription.id).run();

    return json({ ok: true, checkIntervalMinutes, nextCheckAt: next });
  }

  if (method === 'DELETE' && eventMatch) {
    const user = await requireUser(request, env);
    await env.DB.prepare(`
      UPDATE subscriptions SET active = 0, updated_at = ?
      WHERE user_id = ? AND event_id = ?
    `).bind(nowIso(), user.id, eventMatch[1]).run();
    return json({ ok: true });
  }

  const eventDeleteMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/permanent$/);
  if (method === 'DELETE' && eventDeleteMatch) {
    const user = await requireUser(request, env);
    const subscription = await env.DB.prepare(`
      SELECT id FROM subscriptions WHERE user_id = ? AND event_id = ?
    `).bind(user.id, eventDeleteMatch[1]).first();

    if (!subscription) {
      throw new HttpError(404, 'Event watch not found.', 'not_found');
    }

    await env.DB.batch([
      env.DB.prepare('DELETE FROM alert_queue WHERE user_id = ? AND item_key LIKE ?')
        .bind(user.id, `${subscription.id}:%`),
      env.DB.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?')
        .bind(subscription.id, user.id),
    ]);
    return json({ ok: true });
  }

  const eventRestoreMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/restore$/);
  if (method === 'POST' && eventRestoreMatch) {
    const user = await requireUser(request, env);
    const at = nowIso();
    const result = await env.DB.prepare(`
      UPDATE subscriptions
      SET active = 1, next_check_at = NULL, updated_at = ?
      WHERE user_id = ? AND event_id = ? AND active = 0
    `).bind(at, user.id, eventRestoreMatch[1]).run();

    if (!Number(result.meta?.changes || 0)) {
      throw new HttpError(404, 'Archived event not found.', 'not_found');
    }
    return json({ ok: true });
  }

  const checkMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/check$/);
  if (method === 'POST' && checkMatch) {
    const user = await requireUser(request, env);
    const row = await env.DB.prepare(`
      SELECT e.*, s.id AS subscription_id
      FROM events e
      JOIN subscriptions s ON s.event_id = e.id
      WHERE e.id = ? AND s.user_id = ? AND s.active = 1
    `).bind(checkMatch[1], user.id).first();
    if (!row) throw new HttpError(404, 'Event not found.', 'not_found');

    const result = await checkOneEvent(env, row, { subscriptionId: row.subscription_id });
    await flushAlertQueue(env, { userId: user.id });

    const refreshed = await env.DB.prepare(`
      SELECT s.id AS subscription_id, s.check_interval_minutes, s.next_check_at, e.*
      FROM subscriptions s
      JOIN events e ON e.id = s.event_id
      WHERE s.id = ?
    `).bind(row.subscription_id).first();

    return json({ result, event: refreshed });
  }

  const lgsMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)$/);
  if (method === 'PATCH' && lgsMatch) {
    const user = await requireUser(request, env);
    const storeId = lgsMatch[1];
    const body = await readJson(request);
    const checkIntervalMinutes = parseRequestedInterval(body.checkIntervalMinutes);

    const subscription = await env.DB.prepare(`
      SELECT id FROM lgs_subscriptions
      WHERE user_id = ? AND store_id = ? AND active = 1
    `).bind(user.id, storeId).first();
    if (!subscription) throw new HttpError(404, 'LGS watch not found.', 'not_found');

    const at = nowIso();
    const next = nextCheckAt(at, checkIntervalMinutes);
    await env.DB.prepare(`
      UPDATE lgs_subscriptions
      SET check_interval_minutes = ?, next_check_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(checkIntervalMinutes, next, at, subscription.id).run();

    return json({ ok: true, checkIntervalMinutes, nextCheckAt: next });
  }

  if (method === 'DELETE' && lgsMatch) {
    const user = await requireUser(request, env);
    await env.DB.prepare(`
      UPDATE lgs_subscriptions SET active = 0, updated_at = ?
      WHERE user_id = ? AND store_id = ?
    `).bind(nowIso(), user.id, lgsMatch[1]).run();
    return json({ ok: true });
  }

  const lgsDeleteMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)\/permanent$/);
  if (method === 'DELETE' && lgsDeleteMatch) {
    const user = await requireUser(request, env);
    const subscription = await env.DB.prepare(`
      SELECT id FROM lgs_subscriptions WHERE user_id = ? AND store_id = ?
    `).bind(user.id, lgsDeleteMatch[1]).first();

    if (!subscription) {
      throw new HttpError(404, 'LGS watch not found.', 'not_found');
    }

    await env.DB.batch([
      env.DB.prepare('DELETE FROM alert_queue WHERE user_id = ? AND item_key LIKE ?')
        .bind(user.id, `${subscription.id}:%`),
      env.DB.prepare('DELETE FROM lgs_subscriptions WHERE id = ? AND user_id = ?')
        .bind(subscription.id, user.id),
    ]);
    return json({ ok: true });
  }

  const lgsRestoreMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)\/restore$/);
  if (method === 'POST' && lgsRestoreMatch) {
    const user = await requireUser(request, env);
    const at = nowIso();
    const result = await env.DB.prepare(`
      UPDATE lgs_subscriptions
      SET active = 1, next_check_at = NULL, updated_at = ?
      WHERE user_id = ? AND store_id = ? AND active = 0
    `).bind(at, user.id, lgsRestoreMatch[1]).run();

    if (!Number(result.meta?.changes || 0)) {
      throw new HttpError(404, 'Archived LGS watch not found.', 'not_found');
    }
    return json({ ok: true });
  }

  const lgsCheckMatch = url.pathname.match(/^\/api\/lgs\/([^/]+)\/check$/);
  if (method === 'POST' && lgsCheckMatch) {
    const user = await requireUser(request, env);
    const row = await env.DB.prepare(`
      SELECT store.*, sub.id AS subscription_id
      FROM lgs_stores store
      JOIN lgs_subscriptions sub ON sub.store_id = store.id
      WHERE store.id = ? AND sub.user_id = ? AND sub.active = 1
    `).bind(lgsCheckMatch[1], user.id).first();
    if (!row) throw new HttpError(404, 'LGS watch not found.', 'not_found');

    const result = await checkOneLgs(env, row, { subscriptionId: row.subscription_id });
    await flushAlertQueue(env, { userId: user.id });
    const refreshed = await getLgsSubscription(env, user.id, row.id);
    return json({ result, store: refreshed });
  }

  throw new HttpError(404, 'Not found.', 'not_found');
}

function parseRequestedInterval(value) {
  const requested = Number.parseInt(value, 10);
  const checkIntervalMinutes = normalizeCheckInterval(requested, -1);
  if (checkIntervalMinutes === -1) {
    throw new HttpError(400, 'Unsupported refresh interval.', 'invalid_refresh_interval');
  }
  return checkIntervalMinutes;
}

async function getLgsSubscription(env, userId, storeId) {
  return env.DB.prepare(`
    SELECT
      sub.id AS subscription_id,
      sub.check_interval_minutes,
      sub.next_check_at,
      sub.initialized_at,
      store.id AS store_id,
      store.*,
      (
        SELECT COUNT(*) FROM lgs_subscription_events seen
        WHERE seen.subscription_id = sub.id
      ) AS known_event_count
    FROM lgs_subscriptions sub
    JOIN lgs_stores store ON store.id = sub.store_id
    WHERE sub.user_id = ? AND store.id = ? AND sub.active = 1
  `).bind(userId, storeId).first();
}
