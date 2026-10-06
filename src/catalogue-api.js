import { currentUser, requireUser } from "./auth.js";
import { HttpError, json, nowIso, readJson, uuid } from "./utils.js";
import {
  normalizeEventUrl,
  normalizeLgsUrl,
  fetchEvent,
  fetchLgsStore,
} from "./adapters.js";
import { catalogueStoreEvents, refreshCatalogueItem, syncCatalogue } from "./catalogue.js";
import { normalizeCheckInterval } from "./schedule.js";
import { CONNECTORS, getPreferences, savePreferences, browseScope, scopeConditions } from './browse-preferences.js';

const KINDS = {
  event: ["events", "subscriptions", "event_id"],
  store: ["lgs_stores", "lgs_subscriptions", "store_id"],
};
export async function handleCatalogueApi(request, env) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/api/catalogue/preferences') {
    if (method === 'GET') {
      const user = await currentUser(request, env);
      return json({ user, preferences: await getPreferences(env, user), connectors: CONNECTORS });
    }
    if (method === 'PUT') {
      const user = await requireUser(request, env);
      return json({ preferences: await savePreferences(env, user, await readJson(request)) });
    }
  }
  if (method === "POST" && path === "/api/catalogue/refresh") {
    const scope = await browseScope(env, await currentUser(request, env), url.searchParams);
    if (!scope?.sources.length)
      return json({ refreshed: [], setup_required: true });

    const targets = [];
    // Manual refresh is intentionally much more aggressive than the minute cron:
    // users expect this button to materially advance an incomplete catalogue.
    if (scope.sources.includes("uvs")) targets.push(["uvs-events", 10], ["uvs-stores", 10]);
    if (scope.sources.includes("play")) targets.push(["play", 20]);

    const refreshed = [];
    for (const [source, maxPages] of targets) {
      for (let page = 0; page < maxPages; page++) {
        const result = await syncCatalogue(env, { source, force: true, enabled: scope.sources });
        refreshed.push(result);
        if (result.error || result.skipped || result.next == null) break;
      }
    }

    return json({ refreshed });
  }
  if (method === "GET" && path === "/api/catalogue/sources") {
    const scope = await browseScope(env, await currentUser(request, env), url.searchParams);
    if (!scope?.sources.length) return json({ sources: [] });
    const sources =
      (
        await env.DB.prepare(
          "SELECT source, cursor, last_checked_at, last_completed_at, last_error FROM catalogue_sync",
        ).all()
      ).results || [];
    return json({ sources: sources.filter(s => scope.sources.includes(s.source === 'play' ? 'play' : 'uvs')) });
  }
  if (method === "POST" && path === "/api/catalogue/resolve") {
    await requireUser(request, env);
    const body = await readJson(request),
      kind = body.kind;
    if (!KINDS[kind]) throw new HttpError(400, "Choose an event or store.");
    let parsed;
    try {
      parsed =
        kind === "event"
          ? await normalizeEventUrl(body.url)
          : normalizeLgsUrl(body.url);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const [table] = KINDS[kind],
      key = kind === "event" ? "event_key" : "store_key",
      link = kind === "event" ? "event_url" : "store_url";
    const sourceKey = parsed.eventKey || parsed.storeKey;
    const alias = await env.DB.prepare(
      "SELECT entity_id FROM catalogue_sources WHERE kind = ? AND source_key = ?",
    )
      .bind(kind, sourceKey)
      .first();
    let item = alias
      ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
          .bind(alias.entity_id)
          .first()
      : await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
          .bind(sourceKey)
          .first();
    if (!item) {
      const id = uuid(),
        at = nowIso();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO ${table} (id, ${key}, ${link}, adapter, source_host, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          sourceKey,
          parsed.canonicalUrl,
          parsed.adapter,
          parsed.sourceHost,
          parsed.adapter === "play"
            ? "play"
            : parsed.adapter.startsWith("riftbound")
              ? "uvs"
              : "other",
          at,
          at,
        )
        .run();
      item = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
        .bind(sourceKey)
        .first();
    }
    item = await refreshCatalogueItem(env, kind, item);
    if (kind === "event" && item.adapter === "generic") {
      try {
        const snapshot = await fetchEvent(item);
        await env.DB.prepare(
          "UPDATE events SET title = ?, status = ?, status_reason = ?, last_checked_at = ? WHERE id = ?",
        )
          .bind(
            snapshot.title,
            snapshot.status,
            snapshot.reason,
            nowIso(),
            item.id,
          )
          .run();
      } catch {
        /* The detail page reports unknown availability and retains the link. */
      }
    }
    return json({ id: item.id, kind }, 201);
  }
  const listMatch = path.match(/^\/api\/catalogue\/(events|stores)$/);
  if (method === "GET" && listMatch) {
    const kind = listMatch[1] === "events" ? "event" : "store";
    const [table, subs, fk] = KINDS[kind];
    const user = await currentUser(request, env);
    const p = url.searchParams,
      view = p.get("view") || "browse";
    if (
      !["browse", "bookmarks", "watching", "joined", "archive"].includes(view)
    )
      throw new HttpError(400, "Unknown section.");
    if (view !== "browse" && !user)
      throw new HttpError(401, "Sign in to sync and view your saved items.");
    const where = [],
      args = [user?.id || ""];
    if (view === 'browse') {
      const scope = await browseScope(env, user, p);
      if (!scope?.sources.length)
        return json({ items: [], total: 0, page: 1, pages: 0, setup_required: true });
      const constraints = scopeConditions(scope, kind);
      where.push(...constraints.where);
      args.push(...constraints.args);
    }
    if (view === "archive") where.push("s.archived = 1");
    else {
      if (view !== "browse") where.push("s.archived = 0");
      if (view === "bookmarks") where.push("s.bookmarked = 1");
      if (view === "watching") where.push("s.watching = 1");
      if (view === "joined")
        where.push(kind === "event" ? "s.joined = 1" : "0 = 1");
    }
    const q = (p.get("q") || "").trim().slice(0, 200);
    if (q) {
      where.push(
        `(e.title LIKE ? ESCAPE '\\' OR e.address LIKE ? ESCAPE '\\' OR e.city LIKE ? ESCAPE '\\'${kind === "event" ? " OR e.host_lgs LIKE ? ESCAPE '\\'" : ""})`,
      );
      const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(...Array(kind === "event" ? 4 : 3).fill(term));
    }
    if (p.get("source")) {
      where.push(
        `(e.source = ? OR EXISTS (SELECT 1 FROM catalogue_sources cs WHERE cs.kind = ? AND cs.entity_id = e.id AND cs.source = ?))`,
      );
      args.push(p.get("source"), kind, p.get("source"));
    }
    if (p.get("country")) {
      where.push("e.country = ?");
      args.push(p.get("country"));
    }
    if (kind === "event") {
      for (const field of ["format", "category", "status", "store_id"])
        if (p.get(field)) {
          where.push(`e.${field} = ?`);
          args.push(p.get(field));
        }
      if (p.get("price") === "free") where.push("e.price_minor = 0");
      if (p.get("price") === "paid") where.push("e.price_minor > 0");
      for (const [param, operator] of [
        ["from", ">="],
        ["to", "<"],
      ])
        if (p.get(param)) {
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(p.get(param)) ||
            !Number.isFinite(Date.parse(p.get(param)))
          )
            throw new HttpError(400, "Invalid date filter.");
          const date = new Date(`${p.get(param)}T00:00:00Z`);
          if (param === "to") date.setUTCDate(date.getUTCDate() + 1);
          where.push(`e.starts_at ${operator} ?`);
          args.push(date.toISOString());
        }
      if (!p.get("from") && p.get("when") !== "all" && view === "browse") {
        where.push("(e.starts_at IS NULL OR e.starts_at >= ?)");
        args.push(nowIso());
      }
    }
    const sorts = {
      name: "e.title COLLATE NOCASE ASC",
      newest: "e.created_at DESC",
      location:
        "e.country COLLATE NOCASE, e.city COLLATE NOCASE, e.title COLLATE NOCASE",
      date:
        kind === "event"
          ? "e.starts_at IS NULL, e.starts_at ASC"
          : "e.title COLLATE NOCASE ASC",
      latest:
        kind === "event"
          ? "e.starts_at IS NULL, e.starts_at DESC"
          : "e.title COLLATE NOCASE DESC",
    };
    const sort = sorts[p.get("sort") || "date"];
    if (!sort) throw new HttpError(400, "Unknown sort order.");
    const page = Math.max(
      1,
      Math.min(100000, Number.parseInt(p.get("page"), 10) || 1),
    );
    const limit = 24,
      clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM ${table} e LEFT JOIN ${subs} s ON s.${fk} = e.id AND s.user_id = ? ${clause}`;
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total ${from}`)
      .bind(...args)
      .first();
    const fields = `s.id AS subscription_id, COALESCE(s.bookmarked, 0) AS bookmarked, COALESCE(s.watching, 0) AS watching,
      COALESCE(s.archived, 0) AS archived, COALESCE(s.active, 0) AS active, s.check_interval_minutes,
      ${kind === "event" ? "COALESCE(s.joined, 0) AS joined, s.notify_open, s.notify_slots," : ""}
      (SELECT GROUP_CONCAT(DISTINCT cs.source) FROM catalogue_sources cs WHERE cs.entity_id = e.id AND cs.kind = '${kind}') AS sources`;
    const items =
      (
        await env.DB.prepare(
          `SELECT e.*, ${fields} ${from} ORDER BY ${sort}, e.id LIMIT ? OFFSET ?`,
        )
          .bind(...args, limit, (page - 1) * limit)
          .all()
      ).results || [];
    return json({
      items,
      total: count.total,
      page,
      pages: Math.ceil(count.total / limit),
    });
  }
  if (method === "GET" && path === "/api/catalogue/filters") {
    const scope = await browseScope(env, await currentUser(request, env), url.searchParams);
    if (!scope?.sources.length) return json({ country: [], format: [], category: [] });
    const results = {};
    const constraints = scopeConditions(scope, 'event');
    for (const field of ["format", "category"]) {
      const query = `SELECT DISTINCT e.${field} AS value FROM events e WHERE ${constraints.where.join(' AND ')} AND e.${field} IS NOT NULL ORDER BY value`;
      results[field] = ((await env.DB.prepare(query).bind(...constraints.args).all()).results || []).map(
        (r) => r.value,
      );
    }
    results.country = scope.country === '*' ? [] : [scope.country];
    return json(results);
  }
  const match = path.match(
    /^\/api\/catalogue\/(event|store)\/([^/]+)(?:\/(state|events))?$/,
  );
  if (!match) throw new HttpError(404, "Not found.");
  const [, kind, id, action] = match,
    [table, subs, fk] = KINDS[kind];
  let item = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first();
  if (!item) throw new HttpError(404, "This item could not be found.");
  if (method === "GET" && !action) {
    const user = await currentUser(request, env);
    item = await refreshCatalogueItem(env, kind, item);
    const state = user
      ? await env.DB.prepare(
          `SELECT * FROM ${subs} WHERE user_id = ? AND ${fk} = ?`,
        )
          .bind(user.id, id)
          .first()
      : null;
    const sources =
      (
        await env.DB.prepare(
          "SELECT source, url FROM catalogue_sources WHERE kind = ? AND entity_id = ?",
        )
          .bind(kind, id)
          .all()
      ).results || [];
    return json({ item, state, sources });
  }
  if (method === "GET" && kind === "store" && action === "events") {
    let warning = null;
    try {
      if (item.source === "uvs" && item.source_id)
        await catalogueStoreEvents(env, item, { refresh: true });
      else if (item.adapter === "riftbound-store") {
        const snapshot = await fetchLgsStore(item);
        // Preserve older store watches while their public directory entry is being indexed.
        return json({
          events: snapshot.events.map((e) => ({
            title: e.title,
            event_url: e.eventUrl,
            event_key: `riftbound:${e.eventKey}`,
          })),
          warning: null,
        });
      }
    } catch {
      warning =
        "Could not refresh this store. Showing indexed events; the list may be incomplete.";
    }
    const events = await catalogueStoreEvents(env, item);
    return json({ events, warning });
  }
  if (method === "PATCH" && action === "state") {
    const user = await requireUser(request, env),
      body = await readJson(request);
    const allowed =
      kind === "event"
        ? [
            "bookmarked",
            "watching",
            "joined",
            "archived",
            "notify_open",
            "notify_slots",
          ]
        : ["bookmarked", "watching", "archived"];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Object.keys(body).length
    )
      throw new HttpError(400, "Provide an item setting.");
    for (const key of Object.keys(body))
      if (
        !(allowed.includes(key) && typeof body[key] === "boolean") &&
        key !== "check_interval_minutes"
      )
        throw new HttpError(400, "Invalid item setting.");
    let interval;
    if ("check_interval_minutes" in body) {
      interval = normalizeCheckInterval(body.check_interval_minutes, -1);
      if (interval === -1 || !Number.isInteger(body.check_interval_minutes))
        throw new HttpError(400, "Invalid check interval.");
    }
    const at = nowIso();
    // Insert a neutral personal record; a bookmark alone must never start monitoring.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${subs} (id, user_id, ${fk}, active, watching, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?)`,
    )
      .bind(uuid(), user.id, id, at, at)
      .run();
    const prior = await env.DB.prepare(
      `SELECT * FROM ${subs} WHERE user_id = ? AND ${fk} = ?`,
    )
      .bind(user.id, id)
      .first();
    const sets = [],
      values = [];
    for (const key of allowed)
      if (key in body) {
        sets.push(`${key} = ?`);
        values.push(Number(body[key]));
      }
    if (interval !== undefined) {
      sets.push("check_interval_minutes = ?");
      values.push(interval);
    }
    if (body.watching === true && !prior.watching) {
      sets.push("next_check_at = NULL");
      if (kind === "store") sets.push("initialized_at = NULL");
      else {
        sets.push("last_seen_status = ?");
        values.push(item.status || "UNKNOWN");
      }
    }
    sets.push("updated_at = ?");
    values.push(at, prior.id);
    await env.DB.prepare(`UPDATE ${subs} SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
    const state = await env.DB.prepare(`SELECT * FROM ${subs} WHERE id = ?`)
      .bind(prior.id)
      .first();
    return json({ state });
  }
  if (method === "DELETE" && action === "state") {
    const user = await requireUser(request, env);
    await env.DB.prepare(`DELETE FROM ${subs} WHERE user_id = ? AND ${fk} = ?`)
      .bind(user.id, id)
      .run();
    return json({ ok: true });
  }
  throw new HttpError(404, "Not found.");
}
