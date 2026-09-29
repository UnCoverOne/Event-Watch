import { htmlToText } from './riftbound.js';

export async function fetchGenericEvent(eventUrl) {
  const response = await fetch(eventUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'User-Agent': 'EventWatch/1.0 (+availability monitor)',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Event page returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Unsupported page content type: ${contentType.split(';')[0]}`);
  }
  const html = await response.text();
  if (!html || html.length < 80) throw new Error('Event page returned unexpectedly little content');
  return parseGenericHtml(html);
}

export function parseGenericHtml(html) {
  const raw = String(html || '');
  const text = htmlToText(raw);
  const title = extractTitle(raw);

  const soldOut = /\b(sold\s*out|fully\s*booked|event\s+full|registration\s+(?:is\s+)?full|no\s+(?:tickets?|places?|spots?)\s+(?:left|available))\b/i.test(text);
  const closed = /\b(registration|registrations|booking|bookings|ticket\s+sales?)\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:closed|ended)\b|\bregistration\s+deadline\s+(?:has\s+)?passed\b/i.test(text);
  const notOpen = /\b(registration|booking|ticket\s+sales?)\s+(?:is\s+|are\s+)?not\s+(?:yet\s+)?open\b|\b(?:registration|booking|tickets?)\s+(?:opens?|available)\s+(?:on|from|soon)\b|\bcoming\s+soon\b/i.test(text);

  const actionElements = collectActionElementText(raw);
  const positiveAction = actionElements.find((value) =>
    /^(?:register(?:\s+now)?|book(?:\s+now)?|reserve(?:\s+(?:a\s+)?(?:place|spot|seat))?|get\s+tickets?|buy\s+tickets?|join(?:\s+(?:event|now))?|sign\s*up|enrol|enroll)$/i.test(value.trim())
  );
  const disabledPositive = hasDisabledPositiveAction(raw);

  let status = 'UNAVAILABLE';
  let reason = 'No clear registration or booking control is currently visible.';

  if (soldOut) {
    status = 'FULL';
    reason = 'The event page appears to indicate that places or tickets are sold out.';
  } else if (closed) {
    status = 'CLOSED';
    reason = 'The event page appears to indicate that registration or booking is closed.';
  } else if (notOpen) {
    status = 'NOT_OPEN';
    reason = 'The event page appears to indicate that registration or booking is not open yet.';
  } else if (positiveAction && !disabledPositive) {
    status = 'AVAILABLE';
    reason = `A registration or booking control is visible: “${positiveAction.trim().slice(0, 80)}”.`;
  } else if (disabledPositive) {
    status = 'UNAVAILABLE';
    reason = 'A registration or booking control is present but currently disabled.';
  }

  return { title, status, reason, currentPlayers: null, capacity: null };
}

function collectActionElementText(html) {
  const results = [];
  const re = /<(a|button)\b[^>]*>([\s\S]{0,500}?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 100) {
    const value = htmlToText(m[2]).trim();
    if (value) results.push(value);
  }
  const inputRe = /<input\b[^>]*(?:type=["']?(?:submit|button)["']?)[^>]*>/gi;
  while ((m = inputRe.exec(html)) && results.length < 120) {
    const value = m[0].match(/\bvalue=["']([^"']+)["']/i)?.[1];
    if (value) results.push(value.trim());
  }
  return results;
}

function hasDisabledPositiveAction(html) {
  const re = /<(button|input)\b[^>]*\bdisabled\b[^>]*>([\s\S]{0,300}?)<\/button>|<input\b[^>]*\bdisabled\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const snippet = htmlToText(m[0]);
    if (/\b(register|book|reserve|get\s+tickets?|buy\s+tickets?|join|sign\s*up|enrol|enroll)\b/i.test(snippet)) return true;
    const value = m[0].match(/\bvalue=["']([^"']+)["']/i)?.[1] || '';
    if (/\b(register|book|reserve|get\s+tickets?|buy\s+tickets?|join|sign\s*up|enrol|enroll)\b/i.test(value)) return true;
  }
  return false;
}

function extractTitle(raw) {
  const og = raw.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || raw.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i);
  if (og?.[1]) return decodeBasicEntities(og[1]).trim().slice(0, 300);
  const h1 = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return htmlToText(h1[1]).slice(0, 300) || null;
  const title = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title?.[1] ? htmlToText(title[1]).slice(0, 300) || null : null;
}

function decodeBasicEntities(value) {
  return String(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
