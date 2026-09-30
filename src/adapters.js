import { parseRiftboundEventUrl, fetchRiftboundEvent } from './riftbound.js';
import { parseRiftboundStoreUrl, fetchRiftboundStore } from './riftbound-store.js';
import { fetchGenericEvent } from './generic.js';
import { sha256 } from './utils.js';

export async function normalizeEventUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('Enter a valid event page URL.');
  }

  if (url.protocol !== 'https:') throw new Error('Event URLs must use HTTPS.');
  if (url.username || url.password) throw new Error('Event URLs cannot include embedded credentials.');
  if (isPrivateHostname(url.hostname)) throw new Error('Private or local network URLs are not supported.');

  url.hash = '';
  const riftbound = tryParseRiftbound(url.toString());
  if (riftbound) {
    return {
      eventKey: `riftbound:${riftbound.eventKey}`,
      canonicalUrl: riftbound.canonicalUrl,
      adapter: 'riftbound',
      sourceHost: url.hostname,
    };
  }

  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  const canonicalUrl = url.toString();
  const digest = await sha256(canonicalUrl);
  return {
    eventKey: `url:${digest}`,
    canonicalUrl,
    adapter: 'generic',
    sourceHost: url.hostname,
  };
}

export function normalizeLgsUrl(input) {
  let parsed;
  try {
    parsed = parseRiftboundStoreUrl(input);
  } catch (error) {
    throw new Error(`LGS tracking currently supports Riftbound Gaming Network store pages. ${error.message}`);
  }

  const url = new URL(parsed.canonicalUrl);
  return {
    storeKey: `riftbound:${parsed.storeKey}`,
    canonicalUrl: parsed.canonicalUrl,
    adapter: 'riftbound-store',
    sourceHost: url.hostname,
  };
}

export async function fetchEvent(event) {
  if (event.adapter === 'riftbound') return fetchRiftboundEvent(event.event_url);
  return fetchGenericEvent(event.event_url);
}

export async function fetchLgsStore(store) {
  if (store.adapter === 'riftbound-store') return fetchRiftboundStore(store.store_url);
  throw new Error(`Unsupported LGS adapter: ${store.adapter}`);
}

function tryParseRiftbound(input) {
  try { return parseRiftboundEventUrl(input); } catch { return null; }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (host === '0.0.0.0' || host === '::1') return true;
  return false;
}
