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


test('extracts event date and host LGS from Riftbound event header details', () => {
  const result = parseRiftboundHtml(`
    <html><body>
      <h1>Tuesday Evening Nexus Night - 1v1 @ Three Kingdoms</h1>
      <div><span>Apr 14, 2026</span></div>
      <div><a href="/stores/example-store">Three Kingdoms Games</a></div>
      <div>112 Main Street Markham North, Markham, ON, L3P 1Y1, CA</div>
      <div>Starts at 6:30 PM (EDT)</div>
      <button>Log In to Join</button>
    </body></html>`);

  assert.equal(result.eventDate, 'Apr 14, 2026');
  assert.equal(result.hostLgs, 'Three Kingdoms Games');
});

test('leaves host LGS empty if only address-like text follows the event date', () => {
  const result = parseRiftboundHtml(`
    <html><body>
      <h1>Example Event</h1>
      <div>Jul 8, 2026</div>
      <div>117 Russell Parkway, Suite F &amp; G, Warner Robins, GA, 31088, US</div>
      <div>Starts at 6:30 PM (EDT)</div>
    </body></html>`);

  assert.equal(result.eventDate, 'Jul 8, 2026');
  assert.equal(result.hostLgs, null);
});
