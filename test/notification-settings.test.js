import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split('let notificationConfig = null;')[1];
function setup({ permission = 'granted', failApi = false } = {}) {
  const controls = new Map(); const calls = [];
  const $ = id => { if (!controls.has(id)) controls.set(id, { checked: false, disabled: false, textContent: '' }); return controls.get(id); };
  const subscription = { endpoint: 'https://fcm.googleapis.com/test', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/test' }), unsubscribe: async () => { calls.push('unsubscribe'); } };
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async options => { calls.push(['subscribe', options]); return subscription; } } };
  const context = vm.createContext({ $, calls, Uint8Array, atob, encodeURIComponent, setTimeout: () => 0, Notification: { permission: 'default', requestPermission: async () => { calls.push('permission'); return permission; } }, window: { PushManager: {}, Notification: {} }, navigator: { serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } }, api: async (url, options) => { calls.push([url, options]); if (failApi) throw new Error('Save failed'); return {}; } });
  vm.runInContext(`let notificationConfig = { publicKey: '${Buffer.alloc(65, 4).toString('base64url')}' };\n${source}`, context);
  return { context, $, calls };
}
test('enabling device push requests permission from gesture and registers subscription', async () => {
  const { context, $, calls } = setup(); $('pushNotifications').checked = true;
  await vm.runInContext('savePushNotifications()', context);
  assert.equal(calls[0], 'permission'); assert.equal(calls[1][0], 'subscribe');
  assert.equal(calls[1][1].userVisibleOnly, true); assert.equal(calls[1][1].applicationServerKey.length, 65);
  assert.equal(calls[2][0], '/api/push/subscriptions'); assert.equal($('testPush').disabled, false);
});
test('denied permission does not subscribe or save push settings', async () => {
  const { context, $, calls } = setup({ permission: 'denied' }); $('pushNotifications').checked = true;
  await vm.runInContext('savePushNotifications()', context);
  assert.equal(calls.length, 1); assert.equal($('pushNotifications').checked, false); assert.equal($('testPush').disabled, true);
});
test('disabling push removes server delivery before unsubscribing the browser', async () => {
  const { context, $, calls } = setup(); $('pushNotifications').checked = false;
  await vm.runInContext('savePushNotifications()', context);
  assert.equal(calls[0][0], '/api/push/subscriptions'); assert.equal(calls[0][1].method, 'DELETE'); assert.equal(calls[1], 'unsubscribe');
});
test('failed email preference save restores the previous checkbox value', async () => {
  const { context, $, calls } = setup({ failApi: true }); $('emailNotifications').checked = false;
  await vm.runInContext('saveEmailNotifications()', context);
  assert.equal($('emailNotifications').checked, true); assert.equal($('emailNotifications').disabled, false); assert.equal($('notificationStatus').textContent, 'Save failed');
});
