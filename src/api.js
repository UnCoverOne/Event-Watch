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
import { checkOneEvent } from './checker.js';
import { normalizeEventUrl } from './adapters.js';
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
    return json({ ok: true });
  }

  if (method === 'GET' && url.pathname === '/api/events') {
    const user = await requireUser(request, env);
    const rows = await env.DB.prepare(`
      SELECT
        s.id AS subscription_id,
        s.check_interval_minutes,
        s.next_check_at,
        e.id AS event_id,
        e.event_key,
        e.event_url,
        e.adapter,
        e.source_host,
        e.title,
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
      WHERE s.user_id = ? AND s.active = 1
      ORDER BY s.created_at DESC
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

    const refreshed = await env.DB.prepare(`
      SELECT
        s.id AS subscription_id,
        s.check_interval_minutes,
        s.next_check_at,
        e.*
      FROM subscriptions s
      JOIN events e ON e.id = s.event_id
      WHERE s.id = ?
    `).bind(subscriptionId).first();

    return json({ event: refreshed }, 201);
  }

  const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);

  if (method === 'PATCH' && eventMatch) {
    const user = await requireUser(request, env);
    const eventId = eventMatch[1];
    const body = await readJson(request);
    const requested = Number.parseInt(body.checkIntervalMinutes, 10);
    const checkIntervalMinutes = normalizeCheckInterval(requested, -1);

    if (checkIntervalMinutes === -1) {
      throw new HttpError(400, 'Unsupported refresh interval.', 'invalid_refresh_interval');
    }

    const subscription = await env.DB.prepare(`
      SELECT id
      FROM subscriptions
      WHERE user_id = ? AND event_id = ? AND active = 1
    `).bind(user.id, eventId).first();

    if (!subscription) throw new HttpError(404, 'Event not found.', 'not_found');

    const at = nowIso();
    await env.DB.prepare(`
      UPDATE subscriptions
      SET check_interval_minutes = ?,
          next_check_at = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(
      checkIntervalMinutes,
      nextCheckAt(at, checkIntervalMinutes),
      at,
      subscription.id
    ).run();

    return json({
      ok: true,
      checkIntervalMinutes,
      nextCheckAt: nextCheckAt(at, checkIntervalMinutes),
    });
  }

  if (method === 'DELETE' && eventMatch) {
    const user = await requireUser(request, env);
    const eventId = eventMatch[1];
    await env.DB.prepare(`
      UPDATE subscriptions
      SET active = 0, updated_at = ?
      WHERE user_id = ? AND event_id = ?
    `).bind(nowIso(), user.id, eventId).run();
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

    const refreshed = await env.DB.prepare(`
      SELECT
        s.id AS subscription_id,
        s.check_interval_minutes,
        s.next_check_at,
        e.*
      FROM subscriptions s
      JOIN events e ON e.id = s.event_id
      WHERE s.id = ?
    `).bind(row.subscription_id).first();

    return json({ result, event: refreshed });
  }

  throw new HttpError(404, 'Not found.', 'not_found');
}
