import { requireUser } from './auth.js';
import { HttpError, json, readJson, nowIso, uuid } from './utils.js';
import { getPushConfig, validateSubscription, sendPush, decode } from './push.js';

export async function handleNotifications(request, env) {
  const user = await requireUser(request, env);
  const url = new URL(request.url);
  const method = request.method;
  if (url.pathname === '/api/settings/notifications') {
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT email_notifications FROM users WHERE id = ?').bind(user.id).first();
      const { public_key } = await getPushConfig(env);
      return json({ emailEnabled: Boolean(row.email_notifications), emailVerified: user.emailVerified, publicKey: public_key });
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body.emailEnabled !== 'boolean') throw new HttpError(400, 'Specify whether email notifications are enabled.');
      await env.DB.prepare('UPDATE users SET email_notifications = ?, updated_at = ? WHERE id = ?').bind(Number(body.emailEnabled), nowIso(), user.id).run();
      return json({ emailEnabled: body.emailEnabled });
    }
  }
  if (url.pathname === '/api/push/subscriptions') {
    if (method === 'GET') {
      const endpoint = url.searchParams.get('endpoint');
      const row = endpoint ? await env.DB.prepare('SELECT enabled FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(user.id, endpoint).first() : null;
      return json({ enabled: Boolean(row?.enabled) });
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const sub = validateSubscription(body.subscription);
      // Reject invalid curve points before storing a subscription.
      try { await crypto.subtle.importKey('raw', decode(sub.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
      catch { throw new HttpError(400, 'Invalid push encryption key.'); }
      const existing = await env.DB.prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).first();
      if (existing && existing.user_id !== user.id) throw new HttpError(409, 'This device is subscribed to another account. Sign out of that account first.');
      await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, enabled)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, enabled = 1, created_at = excluded.created_at`)
        .bind(existing?.id || uuid(), user.id, sub.endpoint, sub.p256dh, sub.auth, nowIso()).run();
      return json({ enabled: true });
    }
    if (method === 'DELETE') {
      const body = await readJson(request);
      if (typeof body.endpoint !== 'string') throw new HttpError(400, 'Specify this device subscription.');
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0 WHERE user_id = ? AND endpoint = ?').bind(user.id, body.endpoint).run();
      return json({ enabled: false });
    }
  }
  if (url.pathname === '/api/push/test' && method === 'POST') {
    const body = await readJson(request);
    const sub = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ? AND enabled = 1').bind(user.id, String(body.endpoint || '')).first();
    if (!sub) throw new HttpError(400, 'Enable push on this device first.');
    const sent = await sendPush(env, sub, { title: 'Event Watch', body: 'Push notifications are working on this device.', tag: 'event-watch-test', url: '/' });
    if (!sent) throw new HttpError(410, 'This subscription expired. Enable push again.');
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found');
}
