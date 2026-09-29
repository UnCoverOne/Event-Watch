import { HttpError, hashPassword, isValidEmail, normalizeEmail, nowIso, randomToken, sha256, uuid, verifyPassword } from './utils.js';
import { isGmailConfigured, sendVerificationEmail } from './email.js';

const SESSION_COOKIE = 'eventwatch_session';
const SESSION_DAYS = 30;

export async function register(request, env) {
  const body = await request.json();
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
  if (password.length < 12 || password.length > 200) {
    throw new HttpError(400, 'Password must be at least 12 characters.', 'weak_password');
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with this email already exists.', 'email_exists');

  const createdAt = nowIso();
  const userId = uuid();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, email, passwordHash, createdAt, createdAt).run();

  const { cookie } = await createSession(env, userId);
  let verificationSent = false;
  if (isGmailConfigured(env)) {
    try {
      await issueVerification(env, { id: userId, email }, new URL(request.url).origin);
      verificationSent = true;
    } catch (error) {
      console.error('Verification email failed', error);
    }
  }

  return {
    user: { id: userId, email, emailVerified: false },
    cookie,
    verificationSent,
  };
}

export async function login(body, env) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, email_verified_at FROM users WHERE email = ? COLLATE NOCASE'
  ).bind(email).first();

  const fallback = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verifyPassword(password, user?.password_hash || fallback).catch(() => false);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.', 'invalid_credentials');

  const { cookie } = await createSession(env, user.id);
  return {
    user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified_at) },
    cookie,
  };
}

export async function createSession(env, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uuid(), userId, tokenHash, expiresAt, createdAt).run();
  return {
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  };
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function logout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
}

export async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT u.id, u.email, u.email_verified_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, nowIso()).first();
  if (!user) return null;
  return { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified_at) };
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please sign in.', 'unauthorized');
  return user;
}

export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const expected = new URL(request.url).origin;
  if (origin !== expected) throw new HttpError(403, 'Cross-origin request rejected.', 'bad_origin');
}

export async function issueVerification(env, user, requestOrigin = null) {
  if (!isGmailConfigured(env)) throw new HttpError(503, 'Email delivery is not configured.', 'email_not_configured');
  await env.DB.prepare('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL').bind(user.id).run();
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  await env.DB.prepare(
    'INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uuid(), user.id, tokenHash, expiresAt, createdAt).run();
  const origin = String(env.APP_ORIGIN || requestOrigin || '').replace(/\/$/, '');
  await sendVerificationEmail(env, user.email, `${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`);
}

export async function verifyEmailToken(env, token) {
  if (!token) throw new HttpError(400, 'Missing verification token.', 'missing_token');
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT ev.id, ev.user_id, ev.expires_at, ev.used_at
    FROM email_verifications ev
    WHERE ev.token_hash = ?
  `).bind(tokenHash).first();
  if (!row || row.used_at || row.expires_at <= nowIso()) {
    throw new HttpError(400, 'This verification link is invalid or expired.', 'invalid_token');
  }
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?').bind(at, at, row.user_id),
    env.DB.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?').bind(at, row.id),
  ]);
}

function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  for (const pair of cookies.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
