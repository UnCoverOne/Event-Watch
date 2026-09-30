import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRiftboundStoreUrl, parseRiftboundStoreHtml } from '../src/riftbound-store.js';

test('accepts and canonicalizes Riftbound store URLs', () => {
  assert.deepEqual(
    parseRiftboundStoreUrl('https://locator.riftbound.uvsgames.com/stores/E00BADC3-12FF-4857-856E-D870A856BDF4/'),
    {
      storeKey: 'e00badc3-12ff-4857-856e-d870a856bdf4',
      canonicalUrl: 'https://locator.riftbound.uvsgames.com/stores/e00badc3-12ff-4857-856e-d870a856bdf4',
    }
  );
});

test('rejects non-store Riftbound URLs', () => {
  assert.throws(() => parseRiftboundStoreUrl('https://locator.riftbound.uvsgames.com/events/900350'));
});

test('extracts store title and unique event links', () => {
  const result = parseRiftboundStoreHtml(`
    <html><body>
      <h1>TCG Arena</h1>
      <a href="/events/900350"><h3>Nexus Night</h3></a>
      <a href="https://locator.riftbound.uvsgames.com/events/526207">Regional Qualifier</a>
      <a href="/events/900350">Nexus Night duplicate</a>
    </body></html>`);

  assert.equal(result.title, 'TCG Arena');
  assert.deepEqual(result.events, [
    {
      eventKey: '900350',
      eventUrl: 'https://locator.riftbound.uvsgames.com/events/900350',
      title: 'Nexus Night',
    },
    {
      eventKey: '526207',
      eventUrl: 'https://locator.riftbound.uvsgames.com/events/526207',
      title: 'Regional Qualifier',
    },
  ]);
});

test('extracts escaped event paths from embedded page data', () => {
  const result = parseRiftboundStoreHtml(`
    <html><body><h1>Example Store</h1>
    <script>window.data={"href":"\\/events\\/777888"}</script>
    </body></html>`);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventKey, '777888');
});
