import {
  fetchSourcePage,
  sourceJson,
  UVS_API,
  uvsStore,
  uvsEvent,
  playQuery,
  playStore,
  fetchPlayEvent,
  countryCodeFromFormattedAddress,
} from "./sources.js";
import { nowIso, sha256, uuid } from "./utils.js";

const textKey = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const countryKey = (value) => {
  if (!value) return "";
  return countryCodeFromFormattedAddress(String(value)) || textKey(value);
};

const hasCoords = (item) =>
  Number.isFinite(Number(item?.latitude)) &&
  Number.isFinite(Number(item?.longitude));

function distanceKm(a, b) {
  const toRad = (n) => (Number(n) * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.longitude) - toRad(a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function sameStoreIdentity(a, b) {
  if (!a?.title || !b?.title || textKey(a.title) !== textKey(b.title))
    return false;

  const countryA = countryKey(a.country);
  const countryB = countryKey(b.country);
  if (countryA && countryB && countryA !== countryB) return false;

  const cityA = textKey(a.city);
  const cityB = textKey(b.city);
  const addressA = textKey(a.address);
  const addressB = textKey(b.address);
  const sparseA = !cityA && !addressA;
  const sparseB = !cityB && !addressB;

  if (hasCoords(a) && hasCoords(b)) {
    const distance = distanceKm(a, b);
    if (distance <= 3) return true;
    if (
      distance <= 12 &&
      ((cityA && cityB && cityA === cityB) || sparseA || sparseB)
    )
      return true;
    return false;
  }


  if (
    addressA &&
    addressB &&
    (addressA === addressB ||
      (addressA.length >= 10 && addressB.includes(addressA)) ||
      (addressB.length >= 10 && addressA.includes(addressB)))
  )
    return true;

  if (cityA && cityB) return cityA === cityB;

  // Some directory records expose only a store name + country. If the other
  // source has richer location data, exact name + country is enough to attach
  // the sparse listing as an alternate source.
  return Boolean(
    countryA &&
      countryB &&
      countryA === countryB &&
      (sparseA || sparseB),
  );
}
export function fingerprint(kind, item) {
  // Deliberately conservative: never merge merely similar names or nearby venues.
  if (!item.address || !item.title) return null;
  const place = `${textKey(item.address)}|${textKey(item.title)}`;
  if (kind === "store") return place;
  return item.starts_at && item.host_lgs
    ? `${place}|${textKey(item.host_lgs)}|${item.starts_at}`
    : null;
}

function contentHashPayload(kind, item) {
  const common = {
    source: item.source ?? null,
    source_id: item.source_id ?? null,
    url: item.url ?? null,
    title: item.title ?? null,
    city: item.city ?? null,
    country: item.country ?? null,
    address: item.address ?? null,
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    fingerprint: fingerprint(kind, item),
  };
  if (kind === "store") return common;
  return {
    ...common,
    starts_at: item.starts_at ?? null,
    event_date: item.event_date ?? null,
    host_lgs: item.host_lgs ?? null,
    format: item.format ?? null,
    category: item.category ?? null,
    price_minor: item.price_minor ?? null,
    currency: item.currency ?? null,
    description: item.description ?? null,
    status: item.status ?? null,
    status_reason: item.status_reason ?? null,
    current_players: item.current_players ?? null,
    capacity: item.capacity ?? null,
    store: item.store ? contentHashPayload("store", item.store) : null,
  };
}

async function recordContentHash(kind, item) {
  return sha256(JSON.stringify(contentHashPayload(kind, item)));
}

export async function saveRecord(env, kind, item, at = nowIso()) {
  const table = kind === "event" ? "events" : "lgs_stores";
  const keyColumn = kind === "event" ? "event_key" : "store_key";
  const urlColumn = kind === "event" ? "event_url" : "store_url";
  const fp = fingerprint(kind, item);
  // Detail refreshes intentionally invalidate the listing fingerprint so the
  // next catalogue pass reconciles any fields whose source representations differ.
  const contentHash = item.detail ? null : await recordContentHash(kind, item);
  const sourceAlias = await env.DB.prepare(
    `SELECT entity_id, content_hash FROM catalogue_sources
     WHERE kind = ? AND source = ? AND source_key = ?`,
  )
    .bind(kind, item.source, item.key)
    .first();
  if (contentHash && sourceAlias?.content_hash === contentHash)
    return sourceAlias.entity_id;

  let existing = sourceAlias?.entity_id
    ? await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
        .bind(sourceAlias.entity_id)
        .first()
    : null;
  if (!existing)
    existing = await env.DB.prepare(
      `SELECT * FROM ${table}
       WHERE ${keyColumn} = ? OR (source = ? AND source_id = ?)
       LIMIT 1`,
    )
      .bind(item.key, item.source, item.source_id)
      .first();
  if (!existing && fp)
    existing = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE fingerprint = ? LIMIT 1`,
    )
      .bind(fp)
      .first();
  if (!existing && kind === "store" && item.title) {
    const candidates =
      (
        await env.DB.prepare(
          "SELECT * FROM lgs_stores WHERE LOWER(title) = LOWER(?) LIMIT 20",
        )
          .bind(item.title)
          .all()
      ).results || [];
    existing = candidates.find((candidate) =>
      sameStoreIdentity(candidate, item),
    ) || null;
  }
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
    `INSERT INTO catalogue_sources
      (kind, source, source_key, entity_id, url, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, source, source_key) DO UPDATE SET
       entity_id = excluded.entity_id,
       url = excluded.url,
       content_hash = excluded.content_hash
     WHERE catalogue_sources.entity_id IS NOT excluded.entity_id
        OR catalogue_sources.url IS NOT excluded.url
        OR catalogue_sources.content_hash IS NOT excluded.content_hash`,
  )
    .bind(kind, item.source, item.key, id, item.url, contentHash)
    .run();
  return id;
}

export async function mergeCatalogueStores(
  env,
  keepId,
  dropId,
  at = nowIso(),
) {
  if (!keepId || !dropId || keepId === dropId) return keepId;

  const keep = await env.DB.prepare("SELECT * FROM lgs_stores WHERE id = ?")
    .bind(keepId)
    .first();
  const drop = await env.DB.prepare("SELECT * FROM lgs_stores WHERE id = ?")
    .bind(dropId)
    .first();
  if (!keep || !drop) return keep?.id || drop?.id || null;
  if (!sameStoreIdentity(keep, drop))
    throw new Error("Refusing to merge stores with different identities.");

  await env.DB.prepare(
    `UPDATE lgs_stores SET
      title = COALESCE(title, ?),
      city = COALESCE(city, ?),
      country = COALESCE(country, ?),
      address = COALESCE(address, ?),
      latitude = COALESCE(latitude, ?),
      longitude = COALESCE(longitude, ?),
      fingerprint = COALESCE(fingerprint, ?),
      updated_at = ?
    WHERE id = ?`,
  )
    .bind(
      drop.title,
      drop.city,
      drop.country,
      drop.address,
      drop.latitude,
      drop.longitude,
      drop.fingerprint,
      at,
      keepId,
    )
    .run();

  await env.DB.prepare(
    "UPDATE events SET store_id = ? WHERE store_id = ?",
  )
    .bind(keepId, dropId)
    .run();

  await env.DB.prepare(
    "UPDATE catalogue_sources SET entity_id = ? WHERE kind = 'store' AND entity_id = ?",
  )
    .bind(keepId, dropId)
    .run();

  const dropSubscriptions =
    (
      await env.DB.prepare(
        "SELECT * FROM lgs_subscriptions WHERE store_id = ?",
      )
        .bind(dropId)
        .all()
    ).results || [];

  for (const dropSub of dropSubscriptions) {
    const keepSub = await env.DB.prepare(
      "SELECT * FROM lgs_subscriptions WHERE user_id = ? AND store_id = ?",
    )
      .bind(dropSub.user_id, keepId)
      .first();

    if (!keepSub) {
      await env.DB.prepare(
        "UPDATE lgs_subscriptions SET store_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(keepId, at, dropSub.id)
        .run();
      continue;
    }

    const seen =
      (
        await env.DB.prepare(
          "SELECT * FROM lgs_subscription_events WHERE subscription_id = ?",
        )
          .bind(dropSub.id)
          .all()
      ).results || [];
    for (const row of seen) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO lgs_subscription_events
          (subscription_id, event_key, event_url, title, first_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          keepSub.id,
          row.event_key,
          row.event_url,
          row.title,
          row.first_seen_at,
        )
        .run();
    }

    await env.DB.prepare(
      `UPDATE alert_queue
       SET store_subscription_id = ?,
           detail_url = CASE
             WHEN detail_url IS NULL THEN NULL
             ELSE REPLACE(detail_url, ?, ?)
           END
       WHERE store_subscription_id = ?`,
    )
      .bind(keepSub.id, dropId, keepId, dropSub.id)
      .run();

    const nextCheck = [keepSub.next_check_at, dropSub.next_check_at]
      .filter(Boolean)
      .sort()[0] || null;
    await env.DB.prepare(
      `UPDATE lgs_subscriptions SET
        bookmarked = ?,
        watching = ?,
        archived = ?,
        check_interval_minutes = ?,
        next_check_at = ?,
        initialized_at = COALESCE(initialized_at, ?),
        updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        Math.max(Number(keepSub.bookmarked || 0), Number(dropSub.bookmarked || 0)),
        Math.max(Number(keepSub.watching || 0), Number(dropSub.watching || 0)),
        Math.min(Number(keepSub.archived || 0), Number(dropSub.archived || 0)),
        Math.min(
          Number(keepSub.check_interval_minutes || 60),
          Number(dropSub.check_interval_minutes || 60),
        ),
        nextCheck,
        dropSub.initialized_at,
        at,
        keepSub.id,
      )
      .run();

    await env.DB.prepare("DELETE FROM lgs_subscriptions WHERE id = ?")
      .bind(dropSub.id)
      .run();
  }

  await env.DB.prepare("DELETE FROM lgs_stores WHERE id = ?")
    .bind(dropId)
    .run();

  return keepId;
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
        await env.DB.prepare(
          "UPDATE events SET store_id = ? WHERE id = ? AND store_id IS NOT ?",
        )
          .bind(store.id, id, store.id)
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
