import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, hkdfSync, createDecipheriv } from 'node:crypto';
import { encryptPayload, vapidAuthorization, validateSubscription, alertNotification } from '../src/push.js';

function subscription() {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const auth = randomBytes(16);
  return { receiver, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
test('Web Push payload decrypts using independent Node crypto implementation', async () => {
  const { receiver, auth, sub } = subscription();
  const expected = { title: 'Registration available: 日本', url: '/detail.html?kind=event&id=123', body: 'Places opened' };
  const wire = Buffer.from(await encryptPayload(sub, expected));
  assert.equal(wire.readUInt32BE(16), 4096); assert.equal(wire[20], 65);
  const sender = wire.subarray(21, 86), salt = wire.subarray(0, 16);
  const shared = receiver.computeSecret(sender);
  const ikm = hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), sender]), 32);
  const key = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(wire.subarray(-16));
  const plain = Buffer.concat([decipher.update(wire.subarray(86, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2); assert.deepEqual(JSON.parse(plain.subarray(0, -1)), expected);
});
test('VAPID token has correct audience, expiry, public identity and valid signature', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const config = { public_key: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url'), private_jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)) };
  const auth = await vapidAuthorization(config, 'https://fcm.googleapis.com/fcm/send/x', 'https://event-watch.example');
  const token = auth.match(/^vapid t=(.+), k=(.+)$/); assert.equal(token[2], config.public_key);
  const [h, p, sig] = token[1].split('.'); const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert.equal(claims.sub, 'https://event-watch.example');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, Buffer.from(sig, 'base64url'), Buffer.from(`${h}.${p}`)), true);
});
test('subscription validation blocks arbitrary endpoints and malformed keys', () => {
  const { sub } = subscription(); const input = { endpoint: sub.endpoint, keys: sub };
  assert.equal(validateSubscription(input).endpoint, sub.endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x']) assert.throws(() => validateSubscription({ ...input, endpoint }));
  assert.throws(() => validateSubscription({ ...input, keys: { p256dh: 'AAAA', auth: sub.auth } }));
});
test('notification links to the relevant internal watch detail', () => {
  assert.equal(alertNotification({ id: 'a', title: 'Store update', kind: 'lgs_new_event', detail_url: '/detail.html?kind=lgs&id=s' }).url, '/detail.html?kind=lgs&id=s');
});
