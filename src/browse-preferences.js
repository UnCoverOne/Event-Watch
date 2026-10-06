import { HttpError, nowIso } from './utils.js';

export const CONNECTORS = [
  { id: 'uvs', name: 'UVS Gaming Network', url: 'https://locator.riftbound.uvsgames.com/' },
  { id: 'play', name: 'Play Riftbound', url: 'https://playriftbound.com/en-US/events/' },
];

export function validatePreferences(input) {
  if (!input || !Array.isArray(input.sources) || input.sources.length > 10)
    throw new HttpError(400, 'Choose your event sources.');
  const sources = [...new Set(input.sources.map(value => {
    const connector = CONNECTORS.find(c => c.id === value || c.url === value);
    if (!connector) throw new HttpError(400, 'This website does not have an event connector yet. Choose a supported source.');
    return connector.id;
  }))];
  const country = String(input.country || '').toUpperCase();
  if (!/^(\*|[A-Z]{2})$/.test(country))
    throw new HttpError(400, 'Choose a country, or explicitly choose Worldwide.');
  const city = String(input.city || '').trim();
  if (city.length > 100) throw new HttpError(400, 'City must be at most 100 characters.');
  return { sources, country, city };
}

export async function getPreferences(env, user) {
  if (!user) return null;
  const row = await env.DB.prepare('SELECT config FROM user_browse_preferences WHERE user_id = ?').bind(user.id).first();
  return row ? JSON.parse(row.config) : null;
}

export async function savePreferences(env, user, input) {
  const preferences = validatePreferences(input);
  await env.DB.prepare(`INSERT INTO user_browse_preferences (user_id, config, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
    .bind(user.id, JSON.stringify(preferences), nowIso()).run();
  return preferences;
}

export async function browseScope(env, user, params) {
  if (user) return getPreferences(env, user);
  if (!params.has('sources') || !params.has('region')) return null;
  return validatePreferences({ sources: params.get('sources').split(',').filter(Boolean), country: params.get('region'), city: params.get('city') });
}

export function scopeConditions(scope, kind) {
  const marks = scope.sources.map(() => '?').join(',');
  const where = [`(e.source IN (${marks}) OR EXISTS (SELECT 1 FROM catalogue_sources cs WHERE cs.kind = ? AND cs.entity_id = e.id AND cs.source IN (${marks})))`];
  const args = [...scope.sources, kind, ...scope.sources];
  if (scope.country !== '*') {
    const countries = [scope.country];
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(scope.country);
      if (name && name !== scope.country) countries.push(name);
    } catch {}
    if (scope.country === 'GB') countries.push('UK', 'United Kingdom');
    if (scope.country === 'US') countries.push('USA', 'United States', 'United States of America');
    const unique = [...new Set(countries)];
    where.push(`e.country IN (${unique.map(() => '?').join(',')})`);
    args.push(...unique);
  }
  if (scope.city) {
    where.push("e.city LIKE ? ESCAPE '\\'");
    args.push(`%${scope.city.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return { where, args };
}
