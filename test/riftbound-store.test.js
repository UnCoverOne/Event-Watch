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

const storeKey = 'e00badc3-12ff-4857-856e-d870a856bdf4';
function flightHtml({ results = [], next = null, total = results.length, split = false } = {}) {
  const store = { id: storeKey, game: { slug: 'riftbound' }, store: { id: 15614, name: 'TCG Arena' } };
  const query = { queryKey: ['events', { store_id: 15614, game_slug: 'riftbound' }], state: { data: { results, next_page_number: next, total } } };
  const stream = `2b:${JSON.stringify(store)}\n2c:${JSON.stringify({ queries: [query] })}\n`;
  const parts = split ? [stream.slice(0, 77), stream.slice(77)] : [stream];
  return '<html><h1>TCG Arena</h1>' + parts.map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('') + '</html>';
}
const tcgEvents = [
  { id: 1074548, name: 'Nexus Night @ TCG Arena', store: { id: 15614 } },
  { id: 1074549, name: 'Store Tournament @ TCG Arena', store: { id: 15614 } },
  { id: 526207, name: 'Vendetta Skirmish II @ TCG Arena', store: { id: 15614 } },
];
test('TCG Arena Flight JSON yields all three events without any rendered links', () => {
  const parsed = parseRiftboundStoreHtml(flightHtml({ results: tcgEvents, split: true }), storeKey);
  assert.deepEqual(parsed.events.map(e => e.eventKey), ['1074548', '1074549', '526207']);
  assert.equal(parsed.events[0].title, 'Nexus Night @ TCG Arena');
  assert.equal(parsed.storeId, 15614);
});
test('hydrated listing is scoped to the store and ignores unrelated page links', () => {
  const html = flightHtml({ results: tcgEvents }) + '<a href="/events/999">Unrelated event</a>';
  assert.equal(parseRiftboundStoreHtml(html, storeKey).events.length, 3);
});
test('store reader follows every JSON page rather than stopping at the first page', async t => {
  const { fetchRiftboundStore } = await import('../src/riftbound-store.js');
  const pages = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('https://locator.')) return new Response(flightHtml({ results: [tcgEvents[0]], next: 2, total: 3 }));
    const parsed = new URL(url);assert.equal(parsed.searchParams.get('store_id'), '15614');
    const page = Number(parsed.searchParams.get('page'));pages.push(page);
    return Response.json({ results: page === 1 ? [tcgEvents[0]] : tcgEvents.slice(1), next_page_number: page === 1 ? 2 : null, total: 3 });
  });
  const data = await fetchRiftboundStore(`https://locator.riftbound.uvsgames.com/stores/${storeKey}`);
  assert.equal(data.events.length, 3);assert.deepEqual(pages, [1,2]);
});
test('client-only store shell resolves numeric store ID and requests the scoped event API', async t => {
  const { fetchRiftboundStore } = await import('../src/riftbound-store.js');
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url);
    if (path.startsWith('https://locator.')) return new Response('<html><h1>TCG Arena</h1><script>self.__next_f.push([1,"shell"])</script><p>Loading upcoming events...</p></html>');
    if (path.includes('/game-stores/')) return Response.json({ store: { id: 15614, name: 'TCG Arena' } });
    assert.equal(new URL(url).searchParams.get('store_id'), '15614');
    return Response.json({ results: tcgEvents, next_page_number: null, total: 3 });
  });
  assert.equal((await fetchRiftboundStore(`https://locator.riftbound.uvsgames.com/stores/${storeKey}`)).events.length, 3);
});
test('a failed dynamic API lookup is an error, not a false empty listing', async t => {
  const { fetchRiftboundStore } = await import('../src/riftbound-store.js');
  t.mock.method(globalThis, 'fetch', async url => String(url).startsWith('https://locator.') ? new Response('<html><h1>TCG Arena</h1><script>self.__next_f.push([1,"shell"])</script><p>Loading upcoming events...</p></html>') : new Response('', { status: 503 }));
  await assert.rejects(fetchRiftboundStore(`https://locator.riftbound.uvsgames.com/stores/${storeKey}`), /HTTP 503/);
});
