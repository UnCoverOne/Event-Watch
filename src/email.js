import { escapeHtml } from './utils.js';

export async function sendEmail(env, { to, subject, html }) {
  assertGmailConfigured(env);

  const accessToken = await getGmailAccessToken(env);
  const raw = buildMimeMessage({
    fromName: env.GMAIL_FROM_NAME || env.APP_NAME || 'Event Watch',
    fromEmail: env.GMAIL_SENDER_EMAIL,
    to,
    subject,
    html,
  });

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gmail API returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export function isGmailConfigured(env) {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_REFRESH_TOKEN &&
    env.GMAIL_SENDER_EMAIL
  );
}

export async function sendVerificationEmail(env, email, verifyUrl) {
  const appName = escapeHtml(env.APP_NAME || 'Event Watch');
  const safeUrl = escapeHtml(verifyUrl);
  return sendEmail(env, {
    to: email,
    subject: `Verify your email for ${env.APP_NAME || 'Event Watch'}`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:28px;color:#111">
        <h1 style="font-size:22px;margin:0 0 16px">${appName}</h1>
        <p>Verify this email address to receive event availability alerts.</p>
        <p style="margin:24px 0"><a href="${safeUrl}" style="background:#111;color:#fff;text-decoration:none;padding:12px 16px;border-radius:8px;display:inline-block">Verify email</a></p>
        <p style="font-size:13px;color:#666">This link expires in 24 hours.</p>
      </div>`,
  });
}

export async function sendAvailabilityEmail(env, { email, event }) {
  const title = escapeHtml(event.title || 'Watched event');
  const url = escapeHtml(event.event_url);
  const reason = escapeHtml(event.status_reason || 'Registration is available.');
  return sendEmail(env, {
    to: email,
    subject: `Registration available: ${event.title || 'Watched event'}`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:28px;color:#111">
        <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#666">Event Watch alert</p>
        <h1 style="font-size:24px;line-height:1.25;margin:8px 0 12px">${title}</h1>
        <p>${reason}</p>
        <p style="margin:24px 0"><a href="${url}" style="background:#111;color:#fff;text-decoration:none;padding:12px 16px;border-radius:8px;display:inline-block">Open event page</a></p>
        <p style="font-size:13px;color:#666">Event Watch detected a registration or booking signal on the event page. Availability may change quickly; confirm the current status on the source page.</p>
      </div>`,
  });
}

async function getGmailAccessToken(env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload.access_token;
}

function assertGmailConfigured(env) {
  const missing = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!env.GOOGLE_REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');
  if (!env.GMAIL_SENDER_EMAIL) missing.push('GMAIL_SENDER_EMAIL');
  if (missing.length) throw new Error(`Gmail delivery is not configured: missing ${missing.join(', ')}`);
}

function buildMimeMessage({ fromName, fromEmail, to, subject, html }) {
  const boundary = `eventwatch_${crypto.randomUUID().replaceAll('-', '')}`;
  const safeName = sanitizeHeader(fromName);
  const safeFrom = sanitizeHeader(fromEmail);
  const safeTo = sanitizeHeader(to);
  const encodedSubject = encodeHeader(subject);

  const message = [
    `From: ${safeName} <${safeFrom}>`,
    `To: ${safeTo}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlToPlainText(html),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return base64UrlUtf8(message);
}

function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const text = sanitizeHeader(value);
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(text)))}?=`;
}

function base64UrlUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function htmlToPlainText(html) {
  return String(html)
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
