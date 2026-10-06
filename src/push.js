import { base64Url, HttpError } from './utils.js';
const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s);
export function decode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}
export function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0; for (const a of arrays) { out.set(a, offset); offset += a.length; } return out;
}

// Only browser push services may be contacted; never fetch arbitrary client URLs.
export function validateSubscription(input) {
  try {
    const url = new URL(input.endpoint);
    const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        !hosts.includes(url.hostname) || input.endpoint.length > 2048) throw new Error();
    const publicKey = decode(input.keys?.p256dh); const auth = decode(input.keys?.auth);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) throw new Error();
    return { endpoint: url.href, p256dh: input.keys.p256dh, auth: input.keys.auth };
  } catch { throw new HttpError(400, 'Invalid or unsupported push subscription.', 'invalid_push_subscription'); }
}

// Persist one signing identity server-side so subscriptions survive deployments.
export async function getPushConfig(env) {
  let config = await env.DB.prepare('SELECT public_key, private_jwk FROM push_config WHERE id = 1').first();
  if (!config) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    const privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey));
    await env.DB.prepare('INSERT OR IGNORE INTO push_config (id, public_key, private_jwk) VALUES (1, ?, ?)').bind(publicKey, privateJwk).run();
    config = await env.DB.prepare('SELECT public_key, private_jwk FROM push_config WHERE id = 1').first();
  }
  return config;
}
async function hkdf(secret, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8291, one aes128gcm record, with an ephemeral ECDH key per message.
export async function encryptPayload(subscription, payload) {
  const receiverPublic = decode(subscription.p256dh);
  const receiver = await crypto.subtle.importKey('raw', receiverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256));
  const ikm = await hkdf(shared, decode(subscription.auth), concat(bytes('WebPush: info\0'), receiverPublic, senderPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, bytes('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, bytes('Content-Encoding: nonce\0'), 12);
  const plaintext = bytes(JSON.stringify(payload));
  if (plaintext.length > 3000) throw new Error('Push payload too large');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const recordSize = new Uint8Array(4); new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([65]), senderPublic, encrypted);
}
export async function vapidAuthorization(config, endpoint, subject) {
  const head = base64Url(bytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64Url(bytes(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: subject })));
  const signingKey = await crypto.subtle.importKey('jwk', JSON.parse(config.private_jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, bytes(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${base64Url(signature)}, k=${config.public_key}`;
}
export async function sendPush(env, subscription, payload) {
  validateSubscription({ endpoint: subscription.endpoint, keys: subscription });
  const config = await getPushConfig(env);
  const authorization = await vapidAuthorization(config, subscription.endpoint, env.APP_ORIGIN);
  const body = await encryptPayload(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Authorization: authorization, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '86400', Urgency: 'normal' }, body,
  });
  if ([404, 410].includes(response.status)) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(subscription.id).run();
    return false;
  }
  if (!response.ok) throw new Error(`Push service returned ${response.status}`);
  return true;
}
export function alertNotification(alert) {
  return {
    title: (alert.kind === 'lgs_new_event' ? 'New LGS event: ' : 'Registration available: ') + String(alert.title || 'Watched event').slice(0, 120),
    body: String(alert.message || 'Your watched page has an update.').slice(0, 300),
    tag: `event-watch-${alert.id}`,
    url: alert.detail_url || '/',
  };
}
