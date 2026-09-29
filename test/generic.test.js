import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenericHtml } from '../src/generic.js';
import { normalizeEventUrl } from '../src/adapters.js';

test('generic detector finds active register button', () => {
  const result = parseGenericHtml('<html><head><title>Example Conference</title></head><body><button>Register now</button></body></html>');
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.title, 'Example Conference');
});

test('generic detector finds sold out state before action words', () => {
  const result = parseGenericHtml('<html><body><h1>Gig</h1><p>Sold out</p><a href="/info">Get tickets</a></body></html>');
  assert.equal(result.status, 'FULL');
});

test('generic detector finds not-open state', () => {
  const result = parseGenericHtml('<html><body><h1>Workshop</h1><p>Registration is not yet open</p></body></html>');
  assert.equal(result.status, 'NOT_OPEN');
});

test('normalizer accepts arbitrary https URLs and removes tracking', async () => {
  const result = await normalizeEventUrl('https://example.com/events/demo/?utm_source=test#details');
  assert.equal(result.adapter, 'generic');
  assert.equal(result.canonicalUrl, 'https://example.com/events/demo');
  assert.match(result.eventKey, /^url:[0-9a-f]{64}$/);
});

test('normalizer keeps Riftbound as a specialized adapter', async () => {
  const result = await normalizeEventUrl('https://locator.riftbound.uvsgames.com/events/900350');
  assert.equal(result.adapter, 'riftbound');
  assert.equal(result.eventKey, 'riftbound:900350');
});

test('normalizer blocks local/private URLs', async () => {
  await assert.rejects(() => normalizeEventUrl('https://localhost/event'), /Private or local/);
});
