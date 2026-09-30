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
  });

  if (!response.ok) throw new Error(`Riftbound returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html || html.length < 100) throw new Error('Riftbound returned an unexpectedly empty store page');
  return parseRiftboundStoreHtml(html);
}

export function parseRiftboundStoreHtml(html) {
  const raw = String(html || '');
  const title = extractStoreTitle(raw);
  const events = new Map();

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
  };
}

function addEvent(events, eventKey, rawTitle) {
  if (!eventKey) return;
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
