import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import { flushAlertQueue } from '../src/checker.js';
import { handleApi } from '../src/api.js';
import { sha256 } from '../src/utils.js';

function fixture({ email = true, verified = true, push = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO users (id,email,password_hash,created_at,updated_at,email_verified_at,email_notifications) VALUES (?,?,?,?,?,?,?)').run('u', 'user@example.com', 'hash', '2020', '2020', verified ? '2020' : null, Number(email));
  db.prepare('INSERT INTO alert_queue (id,user_id,kind,item_key,title,item_url,message,created_at,detail_url) VALUES (?,?,?,?,?,?,?,?,?)').run('a','u','event_available','item','Event','https://example.com/event','Available','2026-10-06T00:00:00Z','/detail.html?kind=event&id=e');
  const env = { APP_ORIGIN: 'https://event-watch.example', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'token', GMAIL_SENDER_EMAIL: 'sender@example.com', DB: {
    prepare(sql) {
      const statement = db.prepare(sql); let params = [];
      return { bind(...values) { params = values; return this; }, async first() { return statement.get(...params) || null; }, async all() { return { results: statement.all(...params) }; }, async run() { const r = statement.run(...params); return { meta: { changes: r.changes } }; } };
    }, async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  } };
  function addPush(id = 's') {
    const pair = createECDH('prime256v1');pair.generateKeys();
    db.prepare('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)').run(id, 'u', `https://fcm.googleapis.com/fcm/send/${id}`, pair.getPublicKey().toString('base64url'), randomBytes(16).toString('base64url'), '2020');
  }
  if (push) addPush();
  return { env, db, addPush };
}
function mockTransport(t, pushStatus = () => 201) {
  const calls = { email: 0, push: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' });
    if (String(url).includes('gmail.googleapis.com')) { calls.email++; return Response.json({ id: 'sent' }); }
    assert.ok(String(url).startsWith('https://fcm.googleapis.com/')); calls.push++;
    assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
    return new Response('', { status: pushStatus(url) });
  });
  return calls;
}
for (const email of [false, true]) for (const push of [false, true]) {
  test(`email=${email}, push=${push}: sends only enabled channels`, async t => {
    const { env, db } = fixture({ email, push }); const calls = mockTransport(t);
    const result = await flushAlertQueue(env);
    assert.equal(calls.email, Number(email)); assert.equal(calls.push, Number(push)); assert.equal(result.alertsSent, 1);
    await flushAlertQueue(env); assert.equal(calls.email, Number(email)); assert.equal(calls.push, Number(push)); db.close();
  });
}
test('push retries do not repeat successful email or successful device delivery', async t => {
  const { env, db, addPush } = fixture({ push: true }); addPush('s2'); let failed = true;
  const calls = mockTransport(t, url => String(url).endsWith('/s2') && failed ? 503 : 201);
  t.mock.method(console, 'error', () => {});
  await flushAlertQueue(env); assert.equal(calls.email, 1); assert.equal(calls.push, 2); assert.equal(db.prepare('SELECT sent_at FROM alert_queue').get().sent_at, null);
  failed = false; await flushAlertQueue(env); assert.equal(calls.email, 1); assert.equal(calls.push, 3);
  assert.ok(db.prepare('SELECT sent_at FROM alert_queue').get().sent_at); db.close();
});
test('expired device is removed without retrying forever', async t => {
  const { env, db } = fixture({ email: false, push: true }); mockTransport(t, () => 410);
  await flushAlertQueue(env); assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0); assert.ok(db.prepare('SELECT sent_at FROM alert_queue').get().sent_at); db.close();
});
test('unverified email does not block push and waits for verification independently', async t => {
  const { env, db } = fixture({ verified: false, push: true }); const calls = mockTransport(t);
  await flushAlertQueue(env); assert.equal(calls.email, 0); assert.equal(calls.push, 1);
  db.prepare("UPDATE users SET email_verified_at = 'now'").run();
  await flushAlertQueue(env); assert.equal(calls.email, 1); assert.equal(calls.push, 1); db.close();
});
test('newly subscribed device does not receive old queued alerts', async t => {
  const { env, db } = fixture({ email: false, push: true }); const calls = mockTransport(t);
  db.prepare("UPDATE push_subscriptions SET created_at = '2099'").run();
  await flushAlertQueue(env); assert.equal(calls.push, 0); db.close();
});
test('delivery lease prevents concurrent flushes sending duplicates', async t => {
  const { env, db } = fixture({ push: true }); const calls = mockTransport(t);
  await Promise.all([flushAlertQueue(env), flushAlertQueue(env)]);
  assert.equal(calls.email, 1); assert.equal(calls.push, 1); db.close();
});
test('notification APIs require login, persist email preference and return only public signing key', async () => {
  const { env, db } = fixture();
  await assert.rejects(handleApi(new Request('https://event-watch.example/api/settings/notifications'), env), e => e.status === 401);
  const hash = await sha256('session-token');
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run('session','u', hash, '2099', '2020');
  const headers = { cookie: 'eventwatch_session=session-token', origin: env.APP_ORIGIN, 'content-type': 'application/json' };
  const settings = await (await handleApi(new Request(`${env.APP_ORIGIN}/api/settings/notifications`, { headers }), env)).json();
  assert.equal(settings.emailEnabled, true); assert.ok(settings.publicKey); assert.equal(settings.private_jwk, undefined);
  await handleApi(new Request(`${env.APP_ORIGIN}/api/settings/notifications`, { method: 'PATCH', headers, body: JSON.stringify({ emailEnabled: false }) }), env);
  assert.equal(db.prepare('SELECT email_notifications FROM users').get().email_notifications, 0);
  await assert.rejects(handleApi(new Request(`${env.APP_ORIGIN}/api/settings/notifications`, { method: 'PATCH', headers, body: JSON.stringify({ emailEnabled: 'yes' }) }), env), e => e.status === 400);
  db.close();
});

test('device settings are isolated, subscriptions validate and another account cannot take them over', async () => {
  const { env, db, addPush } = fixture({ push: true }); addPush('other-device');
  const tokenHash = await sha256('session-token');
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run('session','u',tokenHash,'2099','2020');
  const headers = { cookie: 'eventwatch_session=session-token', origin: env.APP_ORIGIN, 'content-type': 'application/json' };
  const request = (path, method, body) => handleApi(new Request(env.APP_ORIGIN + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  await request('/api/push/subscriptions', 'DELETE', { endpoint: 'https://fcm.googleapis.com/fcm/send/s' });
  assert.equal(db.prepare("SELECT enabled FROM push_subscriptions WHERE id = 's'").get().enabled, 0);
  assert.equal(db.prepare("SELECT enabled FROM push_subscriptions WHERE id = 'other-device'").get().enabled, 1);
  await assert.rejects(request('/api/push/subscriptions', 'POST', { subscription: { endpoint: 'https://evil.test/' } }), e => e.status === 400);
  const sub = db.prepare("SELECT * FROM push_subscriptions WHERE id = 's'").get();
  await request('/api/push/subscriptions', 'POST', { subscription: { endpoint: sub.endpoint, keys: sub } });
  assert.equal(db.prepare("SELECT enabled FROM push_subscriptions WHERE id = 's'").get().enabled, 1);
  db.prepare("INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ('u2','two@example.com','hash','2020','2020')").run();
  db.prepare("UPDATE sessions SET user_id = 'u2'").run();
  await assert.rejects(request('/api/push/subscriptions', 'POST', { subscription: { endpoint: sub.endpoint, keys: sub } }), e => e.status === 409);
  db.close();
});
