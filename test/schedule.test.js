import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCheckInterval, nextCheckAt } from '../src/schedule.js';

test('accepts supported refresh intervals', () => {
  assert.equal(normalizeCheckInterval(5), 5);
  assert.equal(normalizeCheckInterval('60'), 60);
  assert.equal(normalizeCheckInterval(1440), 1440);
});

test('falls back for unsupported refresh intervals', () => {
  assert.equal(normalizeCheckInterval(7), 5);
  assert.equal(normalizeCheckInterval('banana'), 5);
});

test('calculates the next due time', () => {
  assert.equal(
    nextCheckAt('2026-09-30T00:00:00.000Z', 30),
    '2026-09-30T00:30:00.000Z'
  );
});
