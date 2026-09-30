import test from 'node:test';
import assert from 'node:assert/strict';
import { digestSubject, renderWatchDigest } from '../src/email.js';

test('uses a single digest subject for multiple alerts', () => {
  const alerts = [
    { kind: 'event_available', title: 'Event A', item_url: 'https://example.com/a' },
    { kind: 'lgs_new_event', title: 'Event B', item_url: 'https://example.com/b' },
  ];
  assert.equal(digestSubject(alerts), '2 Event Watch updates');
  const html = renderWatchDigest(alerts);
  assert.match(html, /Event A/);
  assert.match(html, /Event B/);
});
