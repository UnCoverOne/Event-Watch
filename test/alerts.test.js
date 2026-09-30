import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAlertsByUser } from '../src/checker.js';

test('groups multiple changed watches for one user into one digest group', () => {
  const groups = groupAlertsByUser([
    { id: 'a1', user_id: 'u1', email: 'one@example.com', email_verified_at: 'now', title: 'Event A' },
    { id: 'a2', user_id: 'u1', email: 'one@example.com', email_verified_at: 'now', title: 'Event B' },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].alerts.length, 2);
});

test('keeps different users in separate digest groups', () => {
  const groups = groupAlertsByUser([
    { id: 'a1', user_id: 'u1', email: 'one@example.com', email_verified_at: 'now' },
    { id: 'a2', user_id: 'u2', email: 'two@example.com', email_verified_at: 'now' },
  ]);

  assert.equal(groups.length, 2);
});
