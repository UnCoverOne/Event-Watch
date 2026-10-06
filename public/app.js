const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  mode: "login",
  view: "browse",
  kind: "event",
  page: 1,
  pages: 0,
  request: 0,
  detail: null,
};
const INTERVALS = [5, 10, 15, 30, 60, 180, 360, 720, 1440];
const LABELS = {
  browse: [
    "Find your next event.",
    "Explore events and stores across the Riftbound community.",
  ],
  bookmarks: [
    "Worth coming back to.",
    "Your saved events and stores. Bookmarks do not enable notifications.",
  ],
  watching: [
    "Keep an eye on it.",
    "Registration openings, available places and new events at your favourite stores.",
  ],
  joined: [
    "See you there.",
    "Events you have marked as joined. Availability alerts are paused.",
  ],
  archive: [
    "Kept for the record.",
    "Archived events and stores stay saved, with all their watch alerts paused.",
  ],
};
const SOURCE = {
  uvs: "UVS Gaming Network",
  play: "Play Riftbound",
  other: "Other website",
};
const FILTERS = [
  "source",
  "country",
  "format",
  "category",
  "status",
  "price",
  "from",
  "to",
  "when",
];
let toastTimer, searchTimer;

$("navigation").addEventListener("click", (event) => {
  const link = event.target.closest("[data-view]");
  if (!link) return;
  event.preventDefault();
  navigate(new URL(link.href));
});
$("kindTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind]");
  if (!button) return;
  const url = new URL(location.href);
  url.searchParams.set("kind", button.dataset.kind);
  url.searchParams.delete("page");
  navigate(url);
});
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  applyFilters();
});
$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 350);
});
$("filters").addEventListener("change", applyFilters);
$("sortSelect").addEventListener("change", applyFilters);
$("filterToggle").addEventListener("click", () => {
  const expanded = $("filterToggle").getAttribute("aria-expanded") !== "true";
  $("filterToggle").setAttribute("aria-expanded", String(expanded));
  $("filters").classList.toggle("hidden", !expanded);
});
$("resetFilters").addEventListener("click", resetFilters);
$("reloadButton").addEventListener("click", () => {
  loadResults();
  loadSourceStatus();
  loadFilterOptions();
});
$("previousPage").addEventListener("click", () => changePage(-1));
$("nextPage").addEventListener("click", () => changePage(1));
$("emptyAction").addEventListener("click", () => {
  if (!state.user && state.view !== "browse") showAuth();
  else resetFilters();
});
$("signInButton").addEventListener("click", showAuth);
$("logoutButton").addEventListener("click", () => runAction(onLogout));
$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));
$("authForm").addEventListener("submit", onAuthSubmit);
$("addLinkButton").addEventListener("click", () =>
  state.user ? $("addDialog").showModal() : showAuth(),
);
$("addForm").addEventListener("submit", onAddLink);
$("themeToggle").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("event-watch-theme", theme);
  } catch {}
  syncTheme();
});
$("resendVerification").addEventListener("click", () =>
  runAction(async () => {
    await api("/api/auth/resend-verification", { method: "POST" });
    toast("Verification email requested.");
  }),
);
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => $(button.dataset.close).close()),
  );
$("settingsButton").addEventListener("click", openNotificationSettings);
$("closeSettings").addEventListener("click", () =>
  $("notificationSettings").close(),
);
$("emailNotifications").addEventListener("change", saveEmailNotifications);
$("pushNotifications").addEventListener("change", savePushNotifications);
$("testPush").addEventListener("click", testPush);
$("content").addEventListener("click", (event) => {
  const action = event.target.closest("[data-state]");
  if (action) {
    event.preventDefault();
    runAction(() => changeItemState(action));
    return;
  }
  const check = event.target.closest("[data-check]");
  if (check) {
    event.preventDefault();
    runAction(async () => {
      check.disabled = true;
      await api(
        `/api/${check.dataset.kind === "store" ? "lgs" : "events"}/${encodeURIComponent(check.dataset.check)}/check`,
        { method: "POST" },
      );
      await loadDetail(state.kind, check.dataset.check);
      toast("Watch checked.");
    });
    return;
  }
  const link = event.target.closest("a[data-internal]");
  if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    event.preventDefault();
    navigate(new URL(link.href));
  }
  const resolve = event.target.closest("[data-resolve]");
  if (resolve)
    runAction(async () => {
      if (!state.user) return showAuth();
      const data = await api("/api/catalogue/resolve", {
        method: "POST",
        body: { kind: "event", url: resolve.dataset.resolve },
      });
      navigate(new URL(detailUrl("event", data.id), location.origin));
    });
});
$("content").addEventListener("change", (event) => {
  const el = event.target;
  if (!el.matches("[data-preference]") || !state.detail) return;
  runAction(async () => {
    el.disabled = true;
    try {
      await api(`/api/catalogue/${state.kind}/${state.detail.item.id}/state`, {
        method: "PATCH",
        body: {
          [el.dataset.preference]:
            el.type === "checkbox" ? el.checked : Number(el.value),
        },
      });
      toast("Watch settings saved.");
    } catch (error) {
      await loadDetail(state.kind, state.detail.item.id);
      throw error;
    } finally {
      el.disabled = false;
    }
  });
});
window.addEventListener("popstate", route);

async function init() {
  syncTheme();
  try {
    state.user = (await api("/api/me")).user;
  } catch (error) {
    showError(error.message);
  }
  renderSession();
  await loadFilterOptions();
  await route();
  loadSourceStatus();
}
function navigate(url) {
  clearTimeout(searchTimer);
  history.pushState({}, "", url.pathname + url.search);
  route();
}
async function route() {
  const params = new URL(location.href).searchParams;
  state.view = LABELS[params.get("view")] ? params.get("view") : "browse";
  state.kind = ["store", "lgs"].includes(params.get("kind"))
    ? "store"
    : "event";
  state.page = Math.max(1, Number.parseInt(params.get("page"), 10) || 1);
  state.detail = null;
  state.request++;
  $("appError").classList.add("hidden");
  document
    .querySelectorAll("[data-view]")
    .forEach((a) =>
      a.setAttribute(
        "aria-current",
        a.dataset.view === state.view ? "page" : "false",
      ),
    );
  if (params.get("id")) {
    $("browseView").classList.add("hidden");
    $("detailView").classList.remove("hidden");
    if (params.get("store")) {
      // Preserve links from the old store detail pages and notifications.
      try {
        const data = await api(
          `/api/catalogue/store/${encodeURIComponent(params.get("store"))}/events`,
        );
        const found = data.events.find(
          (e) => e.event_key === `riftbound:${params.get("id")}`,
        );
        if (found?.id)
          return navigate(
            new URL(detailUrl("event", found.id), location.origin),
          );
        if (found && state.user) {
          const resolved = await api("/api/catalogue/resolve", {
            method: "POST",
            body: { kind: "event", url: found.event_url },
          });
          return navigate(
            new URL(detailUrl("event", resolved.id), location.origin),
          );
        }
      } catch (error) {
        showError(error.message);
      }
    }
    return loadDetail(state.kind, params.get("id"));
  }
  $("browseView").classList.remove("hidden");
  $("detailView").classList.add("hidden");
  if (state.view === "joined") state.kind = "event";
  $("pageTitle").textContent = LABELS[state.view][0];
  $("pageDescription").textContent = LABELS[state.view][1];
  $("pageEyebrow").textContent =
    state.view === "browse"
      ? "One place. More possibilities."
      : "Your Event Watch";
  document.title = `${state.view === "browse" ? "Browse" : pretty(state.view)} | Event Watch`;
  $("kindTabs").classList.toggle("hidden", state.view === "joined");
  document.querySelectorAll("#kindTabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.kind === state.kind);
    b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind));
  });
  document
    .querySelectorAll(".event-filter")
    .forEach((el) => el.classList.toggle("hidden", state.kind !== "event"));
  $("sortSelect").options[0].textContent =
    state.kind === "event" ? "Soonest first" : "Name A–Z";
  $("sortSelect").options[1].textContent =
    state.kind === "event" ? "Latest first" : "Name Z–A";
  $("searchInput").value = params.get("q") || "";
  for (const key of FILTERS) {
    const el = $(`${key}Filter`),
      value = params.get(key) || (key === "when" ? "upcoming" : "");
    if (
      el.tagName === "SELECT" &&
      value &&
      ![...el.options].some((o) => o.value === value)
    )
      el.add(new Option(pretty(value), value));
    el.value = value;
  }
  $("sortSelect").value = params.get("sort") || "date";
  await loadResults();
}
function applyFilters() {
  const url = new URL(location.href);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("view", state.view);
  url.searchParams.set("kind", state.kind);
  const data = new FormData($("searchForm"));
  for (const [key, value] of data)
    if (
      value &&
      (state.kind === "event" ||
        ![
          "format",
          "category",
          "status",
          "price",
          "from",
          "to",
          "when",
        ].includes(key))
    )
      url.searchParams.set(key, value);
  url.searchParams.set("sort", $("sortSelect").value);
  navigate(url);
}
function resetFilters() {
  navigate(new URL(`/?view=${state.view}&kind=${state.kind}`, location.origin));
}
function changePage(delta) {
  const url = new URL(location.href);
  url.searchParams.set("page", state.page + delta);
  navigate(url);
  $("content").scrollIntoView({ behavior: "instant" });
}
async function loadFilterOptions() {
  try {
    const data = await api("/api/catalogue/filters");
    for (const key of ["country", "format", "category"]) {
      const select = $(`${key}Filter`),
        value = select.value;
      select.replaceChildren(
        new Option(
          key === "country"
            ? "All countries"
            : key === "format"
              ? "All formats"
              : "All types",
          "",
        ),
      );
      for (const option of data[key] || [])
        select.add(
          new Option(
            key === "country" ? countryName(option) : pretty(option),
            option,
          ),
        );
      if (value) select.value = value;
    }
  } catch {
    /* Filters remain usable while the network is unavailable. */
  }
}
async function loadSourceStatus() {
  try {
    const data = await api("/api/catalogue/sources");
    $("sourceStatus").innerHTML =
      `<details><summary>Sources & freshness</summary>${data.sources
        .map((s) => {
          const label =
            s.source === "play"
              ? "Play Riftbound"
              : s.source === "uvs-events"
                ? "UVS events"
                : "UVS stores";
          return `<div>${esc(label)} · ${s.last_error ? "Update unavailable; showing saved data" : s.last_completed_at ? `Updated ${esc(dateTime(s.last_checked_at))}` : "Initial indexing in progress; results are not yet complete"}</div>`;
        })
        .join(
          "",
        )}<div>Play Riftbound stores are discovered through event listings. Search covers the indexed catalogue.</div></details>`;
  } catch {
    $("sourceStatus").textContent =
      "Source freshness is currently unavailable.";
  }
}
async function loadResults() {
  const requestId = ++state.request;
  $("results").setAttribute("aria-busy", "true");
  $("appError").classList.add("hidden");
  if (!state.user && state.view !== "browse") {
    showEmpty(
      "Your events, everywhere.",
      "Sign in or create an account to save and sync your items.",
      "Sign in",
    );
    $("resultCount").textContent = "";
    return;
  }
  $("resultCount").textContent = "Loading…";
  try {
    const params = new URL(location.href).searchParams;
    params.set("view", state.view);
    params.set("page", state.page);
    const data = await api(
      `/api/catalogue/${state.kind === "event" ? "events" : "stores"}?${params}`,
    );
    if (requestId !== state.request) return;
    state.pages = data.pages;
    $("resultCount").textContent =
      `${data.total.toLocaleString()} ${state.kind === "event" ? "event" : "store"}${data.total === 1 ? "" : "s"}`;
    $("results").innerHTML = data.items
      .map((item) => card(item, state.kind))
      .join("");
    $("emptyState").classList.toggle("hidden", data.items.length !== 0);
    $("pagination").classList.toggle("hidden", data.pages <= 1);
    $("pageNumber").textContent = `Page ${data.page} of ${data.pages}`;
    $("previousPage").disabled = data.page <= 1;
    $("nextPage").disabled = data.page >= data.pages;
    if (!data.items.length)
      showEmpty(
        state.view === "browse"
          ? `No ${state.kind === "event" ? "events" : "stores"} found`
          : "Nothing here yet.",
        state.view === "browse"
          ? "Try another location or fewer filters. New source listings are indexed in the background."
          : "Save items from Browse to build your own collection.",
        "Clear filters",
      );
  } catch (error) {
    if (requestId !== state.request) return;
    showError(error.message);
    $("results").innerHTML = "";
    $("resultCount").textContent = "Results could not be loaded.";
    $("pagination").classList.add("hidden");
  } finally {
    if (requestId === state.request)
      $("results").setAttribute("aria-busy", "false");
  }
}
function showEmpty(title, copy, action) {
  $("results").innerHTML = "";
  $("results").setAttribute("aria-busy", "false");
  $("emptyState").classList.remove("hidden");
  $("pagination").classList.add("hidden");
  $("emptyTitle").textContent = title;
  $("emptyCopy").textContent = copy;
  $("emptyAction").textContent = action;
}
function card(item, kind) {
  const sources = [
    ...new Set((item.sources || item.source || "other").split(",")),
  ];
  return `<article class="result-card panel"><div class="card-body"><div class="card-top"><span class="source-label">${sources.map((s) => esc(SOURCE[s] || s)).join(" + ")}</span>${kind === "event" ? status(item.status) : '<span class="tag">Store</span>'}</div>
    ${kind === "event" ? `<p class="card-date">${esc(dateTime(item.starts_at || item.event_date, false))}</p>` : ""}
    <h3 class="card-title"><a data-internal href="${detailUrl(kind, item.id)}">${esc(item.title || "Untitled listing")}</a></h3>
    <div class="card-location">${kind === "event" ? `${esc(item.host_lgs || "Venue not listed")}<br>` : ""}${esc([item.city, item.country ? countryName(item.country) : ""].filter(Boolean).join(", ") || item.address || "Location not listed")}</div>
    <div class="card-tags">${
      kind === "event"
        ? [
            item.format,
            item.category,
            price(item),
            item.capacity != null
              ? `${item.current_players ?? "?"} / ${item.capacity} players`
              : "",
          ]
            .filter(Boolean)
            .map((v) => `<span class="tag">${esc(pretty(v))}</span>`)
            .join("")
        : ""
    }${item.joined ? '<span class="tag saved">Joined · alerts paused</span>' : ""}${item.archived ? '<span class="tag">Archived</span>' : ""}</div></div>${actions(item, kind)}</article>`;
}
function actions(item, kind) {
  const button = (key, label, value, pressed = false) =>
    `<button class="small-button" type="button" data-state="${key}" data-id="${esc(item.id)}" data-kind="${kind}" data-value="${value}" aria-pressed="${pressed}">${label}</button>`;
  return `<div class="card-actions">${button("bookmarked", item.bookmarked ? "★ Saved" : "☆ Save", !item.bookmarked, !!item.bookmarked)}${button("watching", item.watching ? "◉ Watching" : "◎ Watch", !item.watching, !!item.watching)}${kind === "event" ? button("joined", item.joined ? "✓ Joined" : "Mark joined", !item.joined, !!item.joined) : ""}${button("archived", item.archived ? "Restore" : "Archive", !item.archived, !!item.archived)}</div>`;
}
async function changeItemState(button) {
  if (!state.user) return showAuth();
  button.disabled = true;
  try {
    const body = { [button.dataset.state]: button.dataset.value === "true" };
    await api(
      `/api/catalogue/${button.dataset.kind}/${encodeURIComponent(button.dataset.id)}/state`,
      { method: "PATCH", body },
    );
    const message =
      button.dataset.state === "joined" && body.joined
        ? "Marked as joined. Availability alerts paused."
        : button.dataset.state === "archived"
          ? body.archived
            ? "Archived. Watch alerts paused."
            : "Restored. Previous watch preferences kept."
          : "Saved to your account.";
    toast(message);
    if (state.detail) await loadDetail(state.kind, state.detail.item.id);
    else await loadResults();
  } finally {
    button.disabled = false;
  }
}
async function loadDetail(kind, id) {
  const requestId = ++state.request;
  $("detailView").innerHTML = '<p class="muted">Loading details…</p>';
  try {
    const data = await api(`/api/catalogue/${kind}/${encodeURIComponent(id)}`);
    if (requestId !== state.request) return;
    state.detail = data;
    const item = { ...data.item, ...personalState(data.state) };
    document.title = `${item.title || "Details"} | Event Watch`;
    const detailSources = data.sources.length
      ? [...new Map(data.sources.map((s) => [s.url, s])).values()]
      : [{ source: item.source, url: item.event_url || item.store_url }];
    $("detailView").innerHTML =
      `<a class="detail-back" data-internal href="/?view=${state.view}&kind=${kind}">← Back to ${state.view === "browse" ? "browse" : state.view}</a>
      <p class="eyebrow">${kind === "event" ? "Event" : "Store"} details</p>${kind === "event" ? status(item.status) : ""}<h1 class="detail-title">${esc(item.title || "Untitled listing")}</h1>
      <p class="lede">${esc(item.address || item.host_lgs || "")}</p>
      <div class="detail-layout"><div><section class="panel detail-section"><h2>At a glance</h2><dl class="detail-facts">
      ${kind === "event" ? fact("When", dateTime(item.starts_at || item.event_date)) + fact("Store", item.host_lgs || "Not listed", item.store_id ? detailUrl("store", item.store_id) : null) + fact("Format", pretty(item.format || "Not listed")) + fact("Event type", pretty(item.category || "Not listed")) + fact("Entry fee", price(item) || "Not listed") + fact("Players", item.capacity != null ? `${item.current_players ?? "?"} / ${item.capacity}` : "Not published") : fact("Location", item.address || "Not listed") + fact("Country", item.country ? countryName(item.country) : "Not listed")}
      ${fact("Last checked", item.last_checked_at ? dateTime(item.last_checked_at) : "Not checked yet")}</dl>
      ${kind === "event" ? `<p class="detail-copy" style="margin-top:22px">${esc(item.status_reason || "Availability has not been confirmed.")}</p>` : ""}
      ${item.last_error ? `<p class="error">Could not refresh the source. These details may be out of date.</p>` : ""}</section>
      ${item.description ? `<section class="panel detail-section"><h2>About this event</h2><p class="detail-copy">${esc(item.description)}</p></section>` : ""}
      ${kind === "store" ? '<section class="panel detail-section"><h2>Events at this store</h2><div id="storeEvents">Loading store events…</div></section>' : ""}
      <section class="panel detail-section"><h2>Original listings</h2>${detailSources.map((s) => `<a class="source-link" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${esc(SOURCE[s.source] || "Original website")} ↗</a>`).join("")}<p class="hint" style="margin-top:14px">${kind === "event" ? "Register on the original website. Marking Joined here only updates your personal list." : "Store watches alert you when new events are discovered. Existing events form the starting baseline."}</p></section></div>
      <aside><section class="panel detail-section detail-controls"><h2>Your ${kind}</h2>${actions(item, kind)}
      <p class="hint">${item.archived ? "Archived: all watch alerts for this item are paused." : item.joined ? "Joined: availability alerts are paused." : item.watching ? (kind === "event" ? "Watching for registration and available places." : "Watching for newly listed events.") : "Save a bookmark or enable Watch to get notifications."}</p>
      ${
        state.user && item.watching
          ? `<label>Check for updates<select data-preference="check_interval_minutes">${INTERVALS.map((n) => `<option value="${n}" ${Number(item.check_interval_minutes || 5) === n ? "selected" : ""}>${intervalLabel(n)}</option>`).join("")}</select></label>
      ${kind === "event" ? `<label class="check-option"><input type="checkbox" data-preference="notify_open" ${item.notify_open !== 0 ? "checked" : ""}>Registration opens</label><label class="check-option"><input type="checkbox" data-preference="notify_slots" ${item.notify_slots !== 0 ? "checked" : ""}>Places become available</label>` : ""}
      ${item.active ? `<button class="small-button" data-check="${esc(id)}" data-kind="${kind}">Check now</button>` : ""}`
          : ""
      }</section></aside></div>`;
    if (kind === "store") {
      try {
        const listing = await api(
          `/api/catalogue/store/${encodeURIComponent(id)}/events`,
        );
        if (requestId !== state.request) return;
        const events = listing.events || [];
        $("storeEvents").innerHTML =
          (listing.warning
            ? `<p class="error">${esc(listing.warning)}</p>`
            : "") +
          (events.length
            ? events
                .map(
                  (e) =>
                    `<article class="event-row"><div>${e.id ? `<a data-internal href="${detailUrl("event", e.id)}">${esc(e.title || "Event")}</a>` : `<button class="link-button" data-resolve="${esc(e.event_url)}">${esc(e.title || "Event")}</button>`}<p>${esc(dateTime(e.starts_at || e.event_date))}</p></div>${status(e.status || "UNKNOWN")}</article>`,
                )
                .join("")
            : '<p class="muted">No events currently indexed at this store.</p>');
      } catch (error) {
        if ($("storeEvents")) $("storeEvents").textContent = error.message;
      }
    }
  } catch (error) {
    if (requestId === state.request)
      $("detailView").innerHTML =
        `<a class="detail-back" data-internal href="/">← Back to browse</a><h1>Unable to load this item.</h1><p class="error">${esc(error.message)}</p>`;
  }
}
function personalState(record) {
  return record
    ? Object.fromEntries(
        [
          "bookmarked",
          "watching",
          "joined",
          "archived",
          "active",
          "check_interval_minutes",
          "notify_open",
          "notify_slots",
        ].map((k) => [k, record[k]]),
      )
    : {};
}
function fact(label, value, url) {
  return `<div><dt>${esc(label)}</dt><dd>${url ? `<a data-internal href="${url}">${esc(value)}</a>` : esc(value)}</dd></div>`;
}
function showAuth() {
  if (!$("authDialog").open) $("authDialog").showModal();
}
function setAuthMode(mode) {
  state.mode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("passwordInput").autocomplete =
    mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}
async function onAuthSubmit(event) {
  event.preventDefault();
  $("authSubmit").disabled = true;
  $("authError").textContent = "";
  try {
    const data = await api(`/api/auth/${state.mode}`, {
      method: "POST",
      body: {
        email: $("emailInput").value,
        password: $("passwordInput").value,
      },
    });
    state.user = data.user;
    $("authForm").reset();
    $("authDialog").close();
    renderSession();
    await route();
  } catch (error) {
    $("authError").textContent = error.message;
  } finally {
    $("authSubmit").disabled = false;
  }
}
async function onLogout() {
  await disableDevicePush();
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  renderSession();
  await route();
}
function renderSession() {
  $("signInButton").classList.toggle("hidden", !!state.user);
  $("settingsButton").classList.toggle("hidden", !state.user);
  $("logoutButton").classList.toggle("hidden", !state.user);
  $("accountLine").textContent =
    state.user?.email || "Browse freely. Sign in to save and sync.";
  $("verificationBox").classList.toggle(
    "hidden",
    !state.user || state.user.emailVerified,
  );
}
async function onAddLink(event) {
  event.preventDefault();
  const button = $("addForm").querySelector("button[type=submit]");
  button.disabled = true;
  $("addError").textContent = "";
  try {
    const data = await api("/api/catalogue/resolve", {
      method: "POST",
      body: { kind: $("addKind").value, url: $("addUrl").value },
    });
    $("addDialog").close();
    $("addForm").reset();
    navigate(new URL(detailUrl(data.kind, data.id), location.origin));
  } catch (error) {
    $("addError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function syncTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("themeToggle").textContent = dark ? "Light mode" : "Dark mode";
  document.querySelector('meta[name="theme-color"]').content = dark
    ? "#0c0d0f"
    : "#f5f6f2";
}
function status(value) {
  return `<span class="status ${value === "AVAILABLE" ? "available" : value === "FULL" ? "full" : value === "NOT_OPEN" ? "not-open" : ""}">${esc({ AVAILABLE: "Available", FULL: "Full", NOT_OPEN: "Not open yet", CLOSED: "Closed", UNAVAILABLE: "Unavailable", UNKNOWN: "Unknown" }[value] || "Unknown")}</span>`;
}
function detailUrl(kind, id) {
  return `/?kind=${kind}&id=${encodeURIComponent(id)}&view=${state.view}`;
}
function intervalLabel(n) {
  return n < 60
    ? `Every ${n} minutes`
    : n === 60
      ? "Every hour"
      : n === 1440
        ? "Every day"
        : `Every ${n / 60} hours`;
}
function dateTime(value, time = true) {
  if (!value) return "Date not published";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}
function countryName(code) {
  try {
    return (
      new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code
    );
  } catch {
    return code;
  }
}
function price(item) {
  if (item.price_minor == null) return "";
  if (item.price_minor === 0) return "Free";
  if (!item.currency) return "Paid";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: item.currency,
    }).format(item.price_minor / 100);
  } catch {
    return `${item.price_minor / 100} ${item.currency}`;
  }
}
function pretty(value) {
  return String(value || "").includes("_") ||
    String(value || "") === String(value || "").toUpperCase()
    ? String(value || "")
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : String(value || "");
}
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? esc(url.href) : "#";
  } catch {
    return "#";
  }
}
function showError(message) {
  $("appError").textContent = message;
  $("appError").classList.remove("hidden");
}
async function runAction(fn) {
  try {
    await fn();
  } catch (error) {
    showError(error.message);
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3500);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers:
      options.body !== undefined ? { "content-type": "application/json" } : {},
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
if ("serviceWorker" in navigator)
  window.addEventListener("load", () =>
    navigator.serviceWorker
      .register("/sw.js?build=2026-10-06-catalogue-v1", {
        scope: "/",
        updateViaCache: "none",
      })
      .then((r) => r.update())
      .catch(() => {}),
  );
init();

let notificationConfig = null;
const pushSupported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;
async function deviceSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}
async function openNotificationSettings() {
  notificationConfig = null;
  $("notificationSettings").showModal();
  $("notificationStatus").textContent = "Loading settings…";
  $("emailNotifications").disabled = true;
  $("pushNotifications").disabled = true;
  try {
    notificationConfig = await api("/api/settings/notifications");
    $("emailNotifications").checked = notificationConfig.emailEnabled;
    const subscription = await deviceSubscription();
    const status = subscription
      ? await api(
          `/api/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        )
      : { enabled: false };
    $("pushNotifications").checked =
      status.enabled && Notification.permission === "granted";
    $("testPush").disabled = !$("pushNotifications").checked;
    $("notificationStatus").textContent = !pushSupported()
      ? "Push notifications are not supported by this browser."
      : Notification.permission === "denied"
        ? "Notifications are blocked. Allow them in your browser’s site settings, then reopen these settings."
        : !notificationConfig.emailVerified && notificationConfig.emailEnabled
          ? "Verify your email to receive email alerts. Push can be enabled independently."
          : "";
  } catch (error) {
    $("notificationStatus").textContent = error.message;
  } finally {
    $("emailNotifications").disabled = !notificationConfig;
    $("pushNotifications").disabled =
      !notificationConfig ||
      !pushSupported() ||
      Notification.permission === "denied";
  }
}
async function saveEmailNotifications() {
  const input = $("emailNotifications");
  const desired = input.checked;
  input.disabled = true;
  try {
    await api("/api/settings/notifications", {
      method: "PATCH",
      body: { emailEnabled: desired },
    });
    $("notificationStatus").textContent = desired
      ? "Email notifications enabled."
      : "Email notifications disabled.";
  } catch (error) {
    input.checked = !desired;
    $("notificationStatus").textContent = error.message;
  } finally {
    input.disabled = false;
  }
}
async function disableDevicePush() {
  const subscription = await deviceSubscription();
  if (!subscription) return;
  await api("/api/push/subscriptions", {
    method: "DELETE",
    body: { endpoint: subscription.endpoint },
  });
  await subscription.unsubscribe();
}
async function savePushNotifications() {
  const input = $("pushNotifications");
  const desired = input.checked;
  input.disabled = true;
  try {
    if (desired) {
      // Request directly from this user gesture, before other asynchronous work.
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error("Notification permission was not granted.");
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("Push is not ready. Reload the app and try again."),
              ),
            10000,
          ),
        ),
      ]);
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const key = notificationConfig.publicKey
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const applicationServerKey = Uint8Array.from(
          atob(key + "=".repeat((4 - (key.length % 4)) % 4)),
          (c) => c.charCodeAt(0),
        );
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }
      await api("/api/push/subscriptions", {
        method: "POST",
        body: { subscription: subscription.toJSON() },
      });
    } else {
      await disableDevicePush();
    }
    $("notificationStatus").textContent = desired
      ? "Push notifications enabled on this device."
      : "Push notifications disabled on this device.";
  } catch (error) {
    input.checked = !desired;
    $("notificationStatus").textContent = error.message;
  } finally {
    input.disabled = Notification.permission === "denied";
    $("testPush").disabled = !input.checked;
  }
}
async function testPush() {
  $("testPush").disabled = true;
  try {
    const subscription = await deviceSubscription();
    if (!subscription) throw new Error("Enable push on this device first.");
    await api("/api/push/test", {
      method: "POST",
      body: { endpoint: subscription.endpoint },
    });
    $("notificationStatus").textContent =
      "Test sent. Check your device notifications.";
  } catch (error) {
    $("notificationStatus").textContent = error.message;
  } finally {
    $("testPush").disabled = !$("pushNotifications").checked;
  }
}
