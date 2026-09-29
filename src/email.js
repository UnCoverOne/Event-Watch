import { escapeHtml } from './utils.js';

export async function sendEmail(env, { to, subject, html, idempotencyKey = null }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  if (!env.NOTIFICATION_FROM) throw new Error('NOTIFICATION_FROM is not configured');

  const headers = {
    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: env.NOTIFICATION_FROM, to: [to], subject, html }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export async function sendVerificationEmail(env, email, verifyUrl) {
  const appName = escapeHtml(env.APP_NAME || 'Event Watch');
  const safeUrl = escapeHtml(verifyUrl);
  return sendEmail(env, {
    to: email,
    subject: `Verify your email for ${env.APP_NAME || 'Event Watch'}`,
    idempotencyKey: `verify/${await simpleId(email + verifyUrl)}`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:28px;color:#111">
        <h1 style="font-size:22px;margin:0 0 16px">${appName}</h1>
        <p>Verify this email address to receive event availability alerts.</p>
        <p style="margin:24px 0"><a href="${safeUrl}" style="background:#111;color:#fff;text-decoration:none;padding:12px 16px;border-radius:8px;display:inline-block">Verify email</a></p>
        <p style="font-size:13px;color:#666">This link expires in 24 hours.</p>
      </div>`,
  });
}

export async function sendAvailabilityEmail(env, { email, event, notificationId }) {
  const title = escapeHtml(event.title || 'Watched event');
  const url = escapeHtml(event.event_url);
  const reason = escapeHtml(event.status_reason || 'Registration is available.');
  return sendEmail(env, {
    to: email,
    subject: `Registration available: ${event.title || 'Watched event'}`,
    idempotencyKey: `availability/${notificationId}`,
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

async function simpleId(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
