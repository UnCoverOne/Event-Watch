import {
  fetchSourcePage,
  sourceJson,
  UVS_API,
  uvsStore,
  uvsEvent,
  playQuery,
  playStore,
  fetchPlayEvent,
} from "./sources.js";
import { nowIso, uuid } from "./utils.js";

const textKey = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function fingerprint(kind, item) {
  // Deliberately conservative: never merge merely similar names or nearby venues.
  if (!item.address || !item.title) return null;
  const place = `${textKey(item.address)}|${textKey(item.title)}`;
  if (kind === "store") return place;
  return item.starts_at && item.host_lgs
    ? `${place}|${textKey(item.host_lgs)}|${item.starts_at}`
    : null;
}

export async function saveRecord(env, kind, item, at = nowIso()) {
  const table = kind === "event" ? "events" : "lgs_stores";
  const keyColumn = kind === "event" ? "event_key" : "store_key";
  const urlColumn = kind === "event" ? "event_url" : "store_url";
  const fp = fingerprint(kind, item);
  let existing = await env.DB.prepare(
    `SELECT e.* FROM ${table} e WHERE e.${keyColumn} = ? OR e.id IN
    (SELECT entity_id FROM catalogue_sources WHERE kind = ? AND source = ? AND source_key = ?)
    OR (e.source = ? AND e.source_id = ?) LIMIT 1`,
  )
    .bind(item.key, kind, item.source, item.key, item.source, item.source_id)
    .first();
  if (!existing && fp)
    existing = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE fingerprint = ? LIMIT 1`,
    )
      .bind(fp)
      .first();
  const id = existing?.id || uuid();
  let storeId = existing?.store_id || null;
  if (kind === "event" && item.store)
    storeId = await saveRecord(env, "store", item.store, at);
  const common = {
    source: item.source,
    source_id: item.source_id,
    title: item.title,
    city: item.city,
    country: item.country,
    address: item.address,
    latitude: item.latitude,
    longitude: item.longitude,
    fingerprint: fp,
  };
  const details =
    kind === "event"
      ? {
          starts_at: item.starts_at,
          event_date: item.event_date,
          host_lgs: item.host_lgs,
          store_id: storeId,
          format: item.format,
          category: item.category,
          price_minor: item.price_minor,
          currency: item.currency,
          description: item.description,
          status: item.status,
          status_reason: item.status_reason,
          current_players: item.current_players,
          capacity: item.capacity,
        }
      : {};
  // A second listing is attached as an alternate source, not allowed to overwrite the primary source's availability.
  if (!existing || existing.source === item.source) {
    const values = { ...common, ...details };
    if (existing) {
      // Brief search listings must not downgrade a more informative registration check.
      if (
        kind === "event" &&
        !item.detail &&
        item.status === "UNKNOWN" &&
        existing.status !== "UNKNOWN"
      ) {
        delete values.status;
        delete values.status_reason;
      }
      const keys = Object.keys(values);
      await env.DB.prepare(
        `UPDATE ${table} SET ${keys.map((k) => `${k} = COALESCE(?, ${k})`).join(", ")},
        ${urlColumn} = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(
          ...keys.map((k) => values[k] ?? null),
          kind === "store" && item.key.startsWith("uvs-store:")
            ? existing.store_url
            : item.url,
          at,
          id,
        )
        .run();
    } else {
      Object.assign(values, {
        id,
        [keyColumn]: item.key,
        [urlColumn]: item.url,
        adapter: item.adapter,
        source_host: new URL(item.url).hostname,
        created_at: at,
        updated_at: at,
      });
      const keys = Object.keys(values);
      await env.DB.prepare(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
        .bind(...keys.map((k) => values[k] ?? null))
        .run();
    }
  }
  await env.DB.prepare(
    `INSERT INTO catalogue_sources (kind, source, source_key, entity_id, url) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, source, source_key) DO UPDATE SET entity_id = excluded.entity_id, url = excluded.url`,
  )
    .bind(kind, item.source, item.key, id, item.url)
    .run();
  return id;
}

export async function syncCatalogue(
  env,
  { source = null, force = false, enabled = ['uvs', 'play'] } = {},
) {
  const sync = source
    ? await env.DB.prepare("SELECT * FROM catalogue_sync WHERE source = ?")
        .bind(source)
        .first()
    : await env.DB.prepare(
        `SELECT * FROM catalogue_sync WHERE (lease_until IS NULL OR lease_until <= ?)
      AND (last_checked_at IS NULL OR ((cursor IS NOT NULL OR last_error IS NOT NULL OR last_completed_at IS NULL) AND last_checked_at < ?) OR last_checked_at < ?)
      AND ((source IN ('uvs-events', 'uvs-stores') AND ? = 1) OR (source = 'play' AND ? = 1))
      ORDER BY COALESCE(last_checked_at, '') ASC LIMIT 1`,
      )
        .bind(
          nowIso(),
          new Date(Date.now() - 60_000).toISOString(),
          new Date(Date.now() - 30 * 60_000).toISOString(),
          Number(enabled.includes('uvs')),
          Number(enabled.includes('play')),
        )
        .first();
  if (!sync) return { skipped: true };
  const at = nowIso(),
    token = uuid();
  const result = await env.DB.prepare(
    `UPDATE catalogue_sync SET lease_token = ?, lease_until = ? WHERE source = ?
    AND (lease_until IS NULL OR lease_until <= ?)
    AND (? = 1 OR last_checked_at IS NULL OR last_checked_at < ?)`,
  )
    .bind(
      token,
      new Date(Date.now() + 5 * 60_000).toISOString(),
      sync.source,
      at,
      Number(force),
      new Date(Date.now() - 60_000).toISOString(),
    )
    .run();
  if (!result.meta?.changes) return { skipped: true };
  try {
    const page = await fetchSourcePage(sync.source, sync.cursor);
    for (const item of page.stores) await saveRecord(env, "store", item, at);
    for (const item of page.events) await saveRecord(env, "event", item, at);
    await env.DB.prepare(
      `UPDATE catalogue_sync SET cursor = ?, last_checked_at = ?, last_error = NULL,
      last_completed_at = CASE WHEN ? IS NULL THEN ? ELSE last_completed_at END, lease_token = NULL, lease_until = NULL
      WHERE source = ? AND lease_token = ?`,
    )
      .bind(page.next, at, page.next, at, sync.source, token)
      .run();
    return {
      source: sync.source,
      count: page.events.length + page.stores.length,
      next: page.next,
    };
  } catch (error) {
    try {
      await env.DB.prepare(
        `UPDATE catalogue_sync SET last_error = ?, last_checked_at = ?, lease_token = NULL, lease_until = NULL
        WHERE source = ? AND lease_token = ?`,
      )
        .bind(String(error.message).slice(0, 400), at, sync.source, token)
        .run();
    } catch (statusError) {
      console.error(
        "Could not store catalogue sync error",
        sync.source,
        statusError.message,
      );
    }
    console.error("Catalogue sync failed", sync.source, error.message);
    return { source: sync.source, error: error.message };
  }
}

export async function refreshCatalogueItem(env, kind, item) {
  const at = nowIso();
  // Public detail refreshes are shared and throttled, not per-visitor polling.
  if (
    (item.source_id || item.adapter === "generic") &&
    item.last_checked_at &&
    Date.now() - Date.parse(item.last_checked_at) < 5 * 60_000
  )
    return item;
  try {
    if (kind === "event") {
      let record;
      if (item.adapter === "play")
        record = (await fetchPlayEvent(item.event_url)).record;
      else if (item.adapter === "riftbound") {
        const id = item.source_id || item.event_key.replace("riftbound:", "");
        const raw = await sourceJson(
          `${UVS_API}/events/${encodeURIComponent(id)}/`,
        );
        record = uvsEvent(raw.event || raw);
      }
      if (record) await saveRecord(env, kind, { ...record, detail: true }, at);
    } else if (item.source === "play") {
      const data = await playQuery("OrganizerSummary", { id: item.source_id });
      await saveRecord(env, kind, playStore(data.organizerSummary), at);
    } else if (item.store_url.includes("/stores/")) {
      const key = item.store_url.split("/stores/")[1];
      const raw = await sourceJson(
        `${UVS_API}/game-stores/${encodeURIComponent(key)}/`,
      );
      await saveRecord(env, kind, uvsStore(raw), at);
    }
    await env.DB.prepare(
      `UPDATE ${kind === "event" ? "events" : "lgs_stores"} SET last_checked_at = ?, last_error = NULL WHERE id = ?`,
    )
      .bind(at, item.id)
      .run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE ${kind === "event" ? "events" : "lgs_stores"} SET last_checked_at = ?, last_error = ? WHERE id = ?`,
    )
      .bind(at, String(error.message).slice(0, 400), item.id)
      .run();
  }
  return env.DB.prepare(
    `SELECT * FROM ${kind === "event" ? "events" : "lgs_stores"} WHERE id = ?`,
  )
    .bind(item.id)
    .first();
}

export async function catalogueStoreEvents(
  env,
  store,
  { refresh = false } = {},
) {
  if (refresh && store.source === "uvs" && store.source_id) {
    // Get a complete live listing before advancing any watch baseline.
    let page = 1;
    for (;;) {
      const query = new URLSearchParams({
        game_slug: "riftbound",
        store_id: store.source_id,
        upcoming_only: "true",
        page_size: "100",
        page: String(page),
      });
      const data = await sourceJson(`${UVS_API}/events/?${query}`);
      if (!Array.isArray(data.results))
        throw new Error("Invalid store event listing.");
      for (const r of data.results) {
        if (String(r.store?.id) !== store.source_id)
          throw new Error("Source returned events from a different store.");
        const id = await saveRecord(env, "event", uvsEvent(r));
        await env.DB.prepare("UPDATE events SET store_id = ? WHERE id = ?")
          .bind(store.id, id)
          .run();
      }
      const next = data.next_page_number;
      if (next == null) break;
      if (!Number.isSafeInteger(next) || next <= page || next > 100)
        throw new Error("Incomplete store listing.");
      page = next;
    }
  }
  return (
    (
      await env.DB.prepare(
        "SELECT * FROM events WHERE store_id = ? ORDER BY starts_at, id",
      )
        .bind(store.id)
        .all()
    ).results || []
  );
}
