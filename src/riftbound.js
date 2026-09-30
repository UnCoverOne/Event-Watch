const ALLOWED_HOST = 'locator.riftbound.uvsgames.com';

export function parseRiftboundEventUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('Enter a valid Riftbound event URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST) {
    throw new Error(`Event URL must be on ${ALLOWED_HOST}.`);
  }
  const match = url.pathname.match(/^\/events\/(\d+)\/?$/);
  if (!match) throw new Error('URL must point to a Riftbound event page, for example /events/900350.');
  const eventKey = match[1];
  return {
    eventKey,
    canonicalUrl: `https://${ALLOWED_HOST}/events/${eventKey}`,
  };
}

export async function fetchRiftboundEvent(eventUrl) {
  const response = await fetch(eventUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Riftbound returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html || html.length < 100) throw new Error('Riftbound returned an unexpectedly empty page');
  return parseRiftboundHtml(html);
}

export function parseRiftboundHtml(html) {
  const raw = String(html || '');
  const text = htmlToText(raw);
  const title = extractTitle(raw, text);
  const eventDetails = extractEventDetails(raw, title);
  const capacityInfo = extractCapacity(text);

  const fullText = /\b(event|registration)\s+(?:is\s+)?full\b|\bsold\s*out\b|\bjoin\s+(?:the\s+)?waitlist\b|\bwaitlist\s+only\b/i.test(text);
  const capacityFull = capacityInfo.capacity != null && capacityInfo.current != null && capacityInfo.capacity > 0 && capacityInfo.current >= capacityInfo.capacity;
  const closed = /\bregistration\s+(?:is\s+|has\s+)?closed\b|\bregistration\s+(?:has\s+)?ended\b|\bno\s+longer\s+accepting\s+registrations?\b/i.test(text);
  const notOpen = /\bregistration\s+(?:is\s+)?not\s+(?:yet\s+)?open\b|\bregistration\s+(?:will\s+)?opens?\b|\bregistration\s+(?:will\s+)?begins?\b|\bregistration\s+coming\s+soon\b/i.test(text);

  const hasJoinControl = /<(?:button|a)\b[^>]*>[\s\S]{0,300}?\b(?:Log\s*In\s*to\s*Join|Join\s*Event|Register\s*Now|Join\s*Now)\b[\s\S]{0,300}?<\/(?:button|a)>/i.test(raw)
    || /\bLog\s+In\s+to\s+Join\b/i.test(text);

  let status = 'UNAVAILABLE';
  let reason = 'No join control is currently visible on the event page.';

  if (fullText || capacityFull) {
    status = 'FULL';
    reason = capacityFull && capacityInfo.capacity != null
      ? `Event is at capacity (${capacityInfo.current}/${capacityInfo.capacity}).`
      : 'The event page indicates registration is full.';
  } else if (closed) {
    status = 'CLOSED';
    reason = 'The event page indicates registration is closed.';
  } else if (notOpen) {
    status = 'NOT_OPEN';
    reason = 'Registration is not open yet.';
  } else if (hasJoinControl) {
    status = 'AVAILABLE';
    reason = 'A join control is visible on the official event page.';
  }

  return {
    title,
    eventDate: eventDetails.eventDate,
    hostLgs: eventDetails.hostLgs,
    status,
    reason,
    currentPlayers: capacityInfo.current,
    capacity: capacityInfo.capacity,
  };
}

export function htmlToText(html) {
  return decodeHtml(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToLines(html) {
  const stripped = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/[^>]+>/g, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtml(stripped)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractTitle(raw, text) {
  const h1 = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const title = htmlToText(h1[1]);
    if (title) return title.slice(0, 300);
  }
  const titleTag = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    return htmlToText(titleTag[1]).replace(/\s*[|–-]\s*Riftbound Gaming Network\s*$/i, '').slice(0, 300) || null;
  }
  const detail = text.match(/^(.{3,200}?)\s+(?:[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/);
  return detail?.[1]?.slice(0, 300) || null;
}

function extractEventDetails(raw, title) {
  const lines = htmlToLines(raw);
  const datePattern = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/i;
  let dateIndex = lines.findIndex((line) => datePattern.test(line));

  if (dateIndex < 0) {
    const flattened = htmlToText(raw);
    const match = flattened.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i);
    return {
      eventDate: match?.[0] || null,
      hostLgs: null,
    };
  }

  const eventDate = lines[dateIndex];
  let hostLgs = null;

  for (let i = dateIndex + 1; i < Math.min(lines.length, dateIndex + 10); i++) {
    const candidate = lines[i];
    if (!candidate || candidate === title) continue;
    if (/^Starts at\b/i.test(candidate)) break;
    if (/^(?:EVENT DETAILS|START TIME|EST\. END TIME|PLAYERS|CAPACITY|STRUCTURE)$/i.test(candidate)) break;
    if (looksLikeAddress(candidate)) continue;
    if (/^\d+\s+players?$/i.test(candidate)) continue;
    hostLgs = candidate.slice(0, 300);
    break;
  }

  return { eventDate, hostLgs };
}

function looksLikeAddress(value) {
  const text = String(value || '');
  return /\b\d{1,6}\s+\S+/.test(text)
    || /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|way|parkway|pkwy\.?|suite|unit)\b/i.test(text)
    || /,\s*[A-Z]{2,3}\s*,?\s*[A-Z0-9 -]{3,10}\b/i.test(text);
}

function extractCapacity(text) {
  const patterns = [
    /\b(\d+)\s*\/\s*(\d+)\s*(?:players?|spots?)\b/i,
    /\b(\d+)\s+of\s+(\d+)\s+(?:players?|spots?)\b/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return { current: Number(m[1]), capacity: Number(m[2]) };
  }
  return { current: null, capacity: null };
}
