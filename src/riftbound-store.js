import { htmlToText } from './riftbound.js';

const ALLOWED_HOST = 'locator.riftbound.uvsgames.com';
const STORE_PATH = /^\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function parseRiftboundStoreUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('Enter a valid Riftbound LGS page URL.');
  }

  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
    throw new Error(`LGS URL must be on ${ALLOWED_HOST}.`);
  }

  const match = url.pathname.match(STORE_PATH);
  if (!match) {
    throw new Error('URL must point to a Riftbound store page, for example /stores/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.');
  }

  const storeKey = match[1].toLowerCase();
  return {
    storeKey,
    canonicalUrl: `https://${ALLOWED_HOST}/stores/${storeKey}`,
  };
}

export async function fetchRiftboundStore(storeUrl) {
  const response = await fetch(storeUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`Riftbound returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html || html.length < 100) throw new Error('Riftbound returned an unexpectedly empty store page');
  const parsed = parseRiftboundStoreUrl(storeUrl);
  const snapshot = parseRiftboundStoreHtml(html, parsed.storeKey);
  if (!snapshot.listing || snapshot.listing.nextPage) {
    if (!snapshot.storeId && !html.includes('self.__next_f.push')) return snapshot;
    let storeId = snapshot.storeId;
    if (!storeId) {
      const store = await fetchStoreJson(`/api/v2/game-stores/${parsed.storeKey}/`);
      storeId = store.store?.id;
      if (!Number.isSafeInteger(storeId)) throw new Error('Unable to identify the Riftbound store listing.');
      snapshot.title = snapshot.title || store.store?.name || null;
    }
    const events = new Map();
    let page = 1;
    for (;;) {
      const query = new URLSearchParams({ game_slug: 'riftbound', store_id: String(storeId), upcoming_only: 'true', page_size: '100', page: String(page) });
      const listing = await fetchStoreJson(`/api/v2/events/?${query}`);
      if (!Array.isArray(listing.results)) throw new Error('Riftbound returned an invalid event list.');
      for (const event of listing.results) {
        if (event.store?.id !== storeId) throw new Error('Riftbound returned events from a different store.');
        addEvent(events, String(event.id), event.name);
      }
      const next = listing.next_page_number;
      if (next == null) {
        if (Number.isFinite(listing.total) && events.size < listing.total) throw new Error('Riftbound returned an incomplete event list.');
        break;
      }
      if (!Number.isSafeInteger(next) || next <= page || next > 100) throw new Error('Invalid Riftbound event pagination.');
      page = next;
    }
    snapshot.events = [...events.values()];
  }
  return snapshot;
}

async function fetchStoreJson(path) {
  const response = await fetch(`https://api.cloudflare.riftbound.uvsgames.com/hydraproxy${path}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Riftbound listing returned HTTP ${response.status}`);
  return response.json();
}

export function parseRiftboundStoreHtml(html, expectedStoreKey = null) {
  const raw = String(html || '');
  let title = extractStoreTitle(raw);
  const events = new Map();
  const hydration = readHydration(raw, expectedStoreKey);
  if (hydration) {
    title = title || hydration.title;
    if (hydration.listing) {
      for (const event of hydration.listing.results) {
        if (event.store?.id === hydration.storeId) addEvent(events, String(event.id), event.name);
      }
      return { title, events: [...events.values()], storeId: hydration.storeId,
        listing: { nextPage: hydration.listing.next_page_number ?? (hydration.listing.total > events.size ? 1 : null) } };
    }
  }

  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/events\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorPattern.exec(raw))) {
    addEvent(events, anchorMatch[2], htmlToText(anchorMatch[3]));
  }

  const plainPattern = /(?:https:\/\/locator\.riftbound\.uvsgames\.com)?\/events\/(\d+)/gi;
  let plainMatch;
  while ((plainMatch = plainPattern.exec(raw))) {
    addEvent(events, plainMatch[1], null);
  }

  const escapedPattern = /\\\/events\\\/(\d+)/gi;
  let escapedMatch;
  while ((escapedMatch = escapedPattern.exec(raw))) {
    addEvent(events, escapedMatch[1], null);
  }

  return {
    title,
    events: [...events.values()],
    ...(hydration ? { storeId: hydration.storeId, listing: hydration.listing ? { nextPage: hydration.listing.next_page_number ?? null } : null } : {}),
  };
}

function addEvent(events, eventKey, rawTitle) {
  if (!eventKey || !/^\d+$/.test(String(eventKey))) return;
  const key = String(eventKey);
  const current = events.get(key);
  const title = cleanEventTitle(rawTitle);

  if (current) {
    if (!current.title && title) current.title = title;
    return;
  }

  events.set(key, {
    eventKey: key,
    eventUrl: `https://${ALLOWED_HOST}/events/${key}`,
    title,
  });
}

function extractStoreTitle(raw) {
  const h1 = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const title = htmlToText(h1[1]);
    if (title) return title.slice(0, 300);
  }

  const titleTag = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleTag) return null;
  const title = htmlToText(titleTag[1])
    .replace(/\s*[|–-]\s*Riftbound Gaming Network\s*$/i, '')
    .trim();
  return title ? title.slice(0, 300) : null;
}

function cleanEventTitle(value) {
  const title = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || title.length > 300) return null;
  return title;
}


// Next.js embeds query data as JSON strings in its Flight stream; it does not
// render event anchors until hydration. Decode JSON only, never execute scripts.
function readHydration(raw, expectedStoreKey) {
  const chunks = [];
  const scripts = /self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/g;
  for (const match of raw.matchAll(scripts)) {
    try {
      const value = JSON.parse(match[1]);
      if (value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
    } catch { /* Non-data scripts are ignored. */ }
  }
  const roots = [];
  for (const line of chunks.join('').split('\n')) {
    const match = line.match(/^[a-z0-9]+:([\[{].*)$/i);
    if (match) { try { roots.push(JSON.parse(match[1])); } catch { /* Other Flight records are not JSON. */ } }
  }
  const objects = [];
  const pending = [...roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value)) objects.push(value);
    pending.push(...Object.values(value).filter(child => child && typeof child === 'object'));
  }
  const store = objects.find(value => value.game?.slug === 'riftbound' && Number.isSafeInteger(value.store?.id) &&
    typeof value.id === 'string' && (!expectedStoreKey || value.id.toLowerCase() === expectedStoreKey.toLowerCase()));
  if (!store) return null;
  const query = objects.find(value => Array.isArray(value.queryKey) && value.queryKey[0] === 'events' &&
    value.queryKey[1]?.store_id === store.store.id && Array.isArray(value.state?.data?.results));
  return { storeId: store.store.id, title: store.store.name || null, listing: query?.state.data || null };
}
