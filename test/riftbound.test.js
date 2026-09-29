import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRiftboundEventUrl, parseRiftboundHtml } from '../src/riftbound.js';

test('accepts official event URLs and canonicalizes them', () => {
  assert.deepEqual(parseRiftboundEventUrl('https://locator.riftbound.uvsgames.com/events/900350/'), {
    eventKey: '900350',
    canonicalUrl: 'https://locator.riftbound.uvsgames.com/events/900350',
  });
});

test('rejects other hosts', () => {
  assert.throws(() => parseRiftboundEventUrl('https://example.com/events/900350'));
});

test('detects available from join control', () => {
  const result = parseRiftboundHtml(`
    <html><body><h1>Regional Qualifier</h1><div>3 / 32 players</div>
    <button>Log In to Join</button></body></html>`);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.currentPlayers, 3);
  assert.equal(result.capacity, 32);
  assert.equal(result.title, 'Regional Qualifier');
});

test('full capacity wins over a misleading join control', () => {
  const result = parseRiftboundHtml(`
    <html><body><h1>Full Event</h1><div>32 of 32 players</div><button>Log In to Join</button></body></html>`);
  assert.equal(result.status, 'FULL');
});

test('detects not-open registration', () => {
  const result = parseRiftboundHtml(`
    <html><body><h1>Future Event</h1><p>Registration will open on Friday.</p></body></html>`);
  assert.equal(result.status, 'NOT_OPEN');
});

test('does not treat description text saying sign up as an available join control', () => {
  const result = parseRiftboundHtml(`
    <html><body><h1>Store Event</h1><p>Sign up in store to reserve a place.</p></body></html>`);
  assert.equal(result.status, 'UNAVAILABLE');
});
