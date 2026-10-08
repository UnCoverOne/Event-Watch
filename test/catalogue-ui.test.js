import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { CONNECTORS } from '../src/browse-preferences.js';
const html = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const item = {
  id: "e1",
  source: "uvs",
  title: "Nexus Night",
  status: "AVAILABLE",
  starts_at: "2099-11-01T18:00:00Z",
  host_lgs: "Test Store",
  city: "London",
  country: "GB",
  event_url: "https://locator.riftbound.uvsgames.com/events/1",
  bookmarked: 0,
  watching: 0,
  joined: 0,
  archived: 0,
};
async function setup({ guest = false, configured = true, slowFilters = false, savedFilters = null, filterData = null, archived = false, watching = false, joined = false, bookmarked = false, eventOverrides = {} } = {}) {
  const dom = new JSDOM(html, {
    url: "https://event-watch.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let preferences = configured ? { sources: ['uvs', 'play'], country: 'GB', city: '' } : null;
  if (guest && preferences) window.localStorage.setItem('event-watch-browse', JSON.stringify(preferences));
  if (savedFilters) window.localStorage.setItem('event-watch-applied-filters-v1', JSON.stringify(savedFilters));
  const calls = [];
  let current = { ...item, archived: Number(archived), watching: Number(watching), joined: Number(joined), bookmarked: Number(bookmarked), ...eventOverrides };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    let data = {};
    if (url === "/api/catalogue/preferences") {
      if (options.method === 'PUT') preferences = JSON.parse(options.body);
      data = {
        user: guest
          ? null
          : { id: "u", email: "u@example.test", emailVerified: true },
        preferences: guest ? null : preferences,
        connectors: CONNECTORS,
      };
    }
    else if (url.startsWith("/api/catalogue/filters?")) {
      if (slowFilters) return new Promise(() => {});
      data = filterData || { country: ["GB"], city: ["London", "Bristol"], store: ["Test Store", "Other Store"], format: ["Constructed", "Draft"], category: ["LOCALS"] };
    }
    else if (url.startsWith("/api/catalogue/sources?")) data = { sources: [] };
    else if (url.startsWith("/api/catalogue/events?"))
      data = { items: [current], total: 1, page: 1, pages: 1 };
    else if (url === "/api/catalogue/event/e1/state") {
      const body = JSON.parse(options.body);
      current = {
        ...current,
        ...Object.fromEntries(
          Object.entries(body).map(([k, v]) => [k, Number(v)]),
        ),
      };
      data = { state: current };
    } else if (url === "/api/catalogue/event/e1")
      data = { item: current, state: guest ? null : current, sources: [] };
    return { ok: true, json: async () => data };
  };
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.eval(script);
  const settle = async () => {
    for (let i = 0; i < 8; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
  };
  await settle();
  return {
    window,
    document: window.document,
    calls,
    settle,
    close: () => window.close(),
  };
}
test("browse renders guest results and saving opens sign in without mutation", async () => {
  const app = await setup({ guest: true });
  try {
    assert.match(
      app.document.querySelector("#results").textContent,
      /Nexus Night/,
    );
    app.document.querySelector("[data-state=bookmarked]").click();
    await app.settle();
    assert.equal(app.document.querySelector("#authDialog").open, true);
    assert.equal(
      app.calls.some(([url]) => url.endsWith("/state")),
      false,
    );
  } finally {
    app.close();
  }
});
test("saved actions, navigation and public detail stay inside the app", async () => {
  const app = await setup();
  try {
    app.document.querySelector("[data-state=bookmarked]").click();
    await app.settle();
    assert.equal(
      JSON.parse(app.calls.find(([url]) => url.endsWith("/state"))[1].body)
        .bookmarked,
      true,
    );
    assert.match(app.document.querySelector("#results").textContent, /Saved/);
    app.document.querySelector(".card-title a").click();
    await app.settle();
    assert.equal(app.window.location.search.includes("id=e1"), true);
    assert.match(
      app.document.querySelector("#detailView").textContent,
      /Nexus Night/,
    );
    assert.equal(
      app.document.querySelector("#browseView").classList.contains("hidden"),
      true,
    );
    app.document.querySelector("#detailView [data-state=joined]").click();
    await app.settle();
    assert.match(
      app.document.querySelector("#detailView").textContent,
      /Joined: availability alerts are paused/,
    );
  } finally {
    app.close();
  }
});
test("filters and source selection are reflected in server queries", async () => {
  const app = await setup();
  try {
    app.document.querySelector("#searchInput").value = "London";
    app.document.querySelector("#countryFilter").value = "GB";
    app.document.querySelector("#sourceFilter").value = "play";
    app.document
      .querySelector("#searchForm")
      .dispatchEvent(
        new app.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await app.settle();
    const request = app.calls
      .filter(([url]) => url.startsWith("/api/catalogue/events?"))
      .at(-1)[0];
    assert.match(request, /q=London/);
    assert.match(request, /country=GB/);
    assert.match(request, /source=play/);
  } finally {
    app.close();
  }
});

test('new visitors choose sources and location before any catalogue requests', async () => {
  for (const guest of [true, false]) {
    const app = await setup({ guest, configured: false });
    try {
      assert.equal(app.document.querySelector('#setupView').classList.contains('hidden'), false);
      assert.equal(app.calls.some(([url]) => /catalogue\/(events|stores|filters|sources)\?/.test(url)), false);
      app.document.querySelector('[data-add-source=uvs]').click();
      await app.settle();
      assert.equal(app.calls.some(([url]) => url.startsWith('/api/catalogue/events?')), false);
      app.document.querySelector('#setupCountry').value = 'RO';
      app.document.querySelector('#setupCity').value = 'București';
      app.document.querySelector('#sourceSetupForm').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
      await app.settle();
      const query = app.calls.find(([url]) => url.startsWith('/api/catalogue/events?'))[0];
      assert.match(query, /sources=uvs/);
      assert.match(query, /region=RO/);
      assert.equal(new URL(query, 'https://test').searchParams.get('scope_city'), 'București');
      assert.equal(app.calls.some(([url, opts]) => url === '/api/catalogue/preferences' && opts.method === 'PUT'), !guest);
    } finally { app.close(); }
  }
});

test('event results do not wait for filter metadata; repeated routes reuse recent results', async () => {
  const app = await setup({ slowFilters: true });
  try {
    assert.match(app.document.querySelector('#results').textContent, /Nexus Night/);
    const before = app.calls.filter(([url]) => url.startsWith('/api/catalogue/events?')).length;
    app.document.querySelector('[data-view=browse]').click();
    await app.settle();
    assert.equal(app.calls.filter(([url]) => url.startsWith('/api/catalogue/events?')).length, before);
  } finally { app.close(); }
});

test('removing the last source pauses browsing and unsupported websites are rejected', async () => {
  const app = await setup();
  try {
    app.document.querySelector('#manageSources').click();
    app.document.querySelector('#sourceUrl').value = 'https://unsupported.example/events';
    app.document.querySelector('#addSource').click();
    assert.match(app.document.querySelector('#sourceError').textContent, /not supported/);
    app.document.querySelector('[data-remove-source=uvs]').click();
    app.document.querySelector('[data-remove-source=play]').click();
    const before = app.calls.filter(([url]) => url.startsWith('/api/catalogue/events?')).length;
    app.document.querySelector('#sourceSetupForm').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await app.settle();
    assert.equal(app.calls.filter(([url]) => url.startsWith('/api/catalogue/events?')).length, before);
    assert.equal(app.document.querySelector('#setupView').classList.contains('hidden'), false);
  } finally { app.close(); }
});

test('profile menu supports dismissal and opens Profile and guest Settings', async () => {
  const app = await setup({ guest: true, configured: false });
  try {
    const button = app.document.querySelector('#profileButton');
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(app.document.activeElement.id, 'profileMenuItem');
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(app.document.activeElement, button);
    button.click();
    app.document.querySelector('#profileMenuItem').click();
    assert.equal(app.document.querySelector('#profileDialog').open, true);
    assert.equal(app.document.querySelector('#profileEmail').textContent, 'Guest');
    app.document.querySelector('[data-close=profileDialog]').click();
    button.click();
    app.document.querySelector('#settingsButton').click();
    assert.equal(app.document.querySelector('#notificationSettings').open, true);
    assert.equal(app.document.querySelector('#notificationControls').classList.contains('hidden'), true);
    assert.equal(app.calls.some(([url]) => url === '/api/settings/notifications'), false);
    app.document.querySelector('#closeSettings').click();
    button.click();
    app.document.querySelector('#content').click();
    assert.equal(button.getAttribute('aria-expanded'), 'false');
  } finally { app.close(); }
});

test('theme switch exposes and persists the selected theme without losing its thumb', async () => {
  const app = await setup();
  try {
    const toggle = app.document.querySelector('#themeToggle');
    assert.equal(toggle.getAttribute('role'), 'switch');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.equal(app.document.documentElement.dataset.theme, 'light');
    assert.equal(app.window.localStorage.getItem('event-watch-theme'), 'light');
    assert.ok(toggle.querySelector('.theme-thumb'));
    toggle.click();
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(app.window.localStorage.getItem('event-watch-theme'), 'dark');
    app.document.querySelector('#profileButton').click();
    app.document.querySelector('#profileMenuItem').click();
    assert.equal(app.document.querySelector('#profileEmail').textContent, 'u@example.test');
    assert.equal(app.document.querySelector('#profileVerification').textContent, 'Verified');
  } finally { app.close(); }
});

test("bespoke filter dialog supports multi-select City and Store, and restores applied filters", async () => {
  const app = await setup();
  try {
    const cityButton = app.document.querySelector('[data-filter-open=city]');
    cityButton.click();
    assert.equal(app.document.querySelector("#filterDialog").open, true);
    assert.equal(app.document.querySelector("#filterDialogTitle").textContent, "City");
    assert.equal(app.document.querySelector("#filterOptionList input[type=checkbox]").type, "checkbox");
    for (const city of ["London", "Bristol"])
      app.document.querySelector(`#filterOptionList input[value="${city}"]`).click();
    app.document.querySelector("#applyFilterChoice").click();
    await app.settle();
    assert.equal(app.document.querySelector('[data-filter-summary=city]').textContent, "2 selected");
    app.document.querySelector('[data-filter-open=store]').click();
    for (const store of ["Test Store", "Other Store"])
      app.document.querySelector(`#filterOptionList input[value="${store}"]`).click();
    app.document.querySelector("#applyFilterChoice").click();
    await app.settle();
    const request = app.calls.filter(([url]) => url.startsWith("/api/catalogue/events?")).at(-1)[0];
    const url = new URL(request, "https://event-watch.test");
    assert.deepEqual(url.searchParams.getAll("city"), ["London", "Bristol"]);
    assert.deepEqual(url.searchParams.getAll("store"), ["Test Store", "Other Store"]);
    const saved = JSON.parse(app.window.localStorage.getItem("event-watch-applied-filters-v1"));
    assert.match(saved["u:browse:event"], /city=London/);
    assert.match(saved["u:browse:event"], /store=Other\+Store/);
    app.document.querySelector('[data-view=browse]').click();
    await app.settle();
    assert.deepEqual(new URL(app.window.location.href).searchParams.getAll("city"), ["London", "Bristol"]);
    app.document.querySelector("#resetFilters").click();
    await app.settle();
    assert.equal(new URL(app.window.location.href).searchParams.has("city"), false);
    assert.equal(JSON.parse(app.window.localStorage.getItem("event-watch-applied-filters-v1"))["u:browse:event"], "");
  } finally {
    app.close();
  }
});

test("previously selected filters are restored for the right account, view and kind", async () => {
  const savedFilters = {
    "u:browse:event": "city=London&city=Bristol&store=Test+Store",
    "u:browse:store": "city=Bristol",
  };
  const app = await setup({ savedFilters });
  try {
    assert.deepEqual(new URL(app.window.location.href).searchParams.getAll("city"), ["London", "Bristol"]);
    assert.equal(app.document.querySelector('[data-filter-summary=city]').textContent, "2 selected");
    app.document.querySelector('[data-kind=store]').click();
    await app.settle();
    assert.deepEqual(new URL(app.window.location.href).searchParams.getAll("city"), ["Bristol"]);
    assert.equal(new URL(app.window.location.href).searchParams.has("store"), false);
  } finally {
    app.close();
  }
});

test("filter choices deduplicate Constructed and display formatted multi-word names", async () => {
  const app = await setup({
    filterData: {
      country: ["GB"], city: ["London"], store: ["Test Store"],
      format: ["Constructed", "CONSTRUCTED", "TWIN_SUNS", "Twin Suns"],
      category: ["LOCALS", "WEEKLY_EVENT", "Weekly Event"],
    },
  });
  try {
    app.document.querySelector('[data-filter-open=format]').click();
    const names = [...app.document.querySelectorAll('#filterOptionList .filter-option span')]
      .map(el => el.textContent);
    assert.deepEqual(names, ["Constructed", "Twin Suns"]);
    app.document.querySelector('#filterOptionList input[value="TWIN_SUNS"]').click();
    app.document.querySelector("#applyFilterChoice").click();
    await app.settle();
    assert.equal(app.document.querySelector('[data-filter-summary=format]').textContent, "Twin Suns");
    app.document.querySelector('[data-filter-open=category]').click();
    const types = [...app.document.querySelectorAll('#filterOptionList .filter-option span')]
      .map(el => el.textContent);
    assert.deepEqual(types, ["Locals", "Weekly Event"]);
    app.document.querySelector("#closeFilterDialog").click();
  } finally {
    app.close();
  }
});

test("saved format variations display as one selected choice", async () => {
  const app = await setup({
    savedFilters: { "u:browse:event": "format=CONSTRUCTED&format=Constructed" },
    filterData: { country: ["GB"], city: [], store: [], format: ["Constructed", "CONSTRUCTED"], category: [] },
  });
  try {
    assert.equal(app.document.querySelector('[data-filter-summary=format]').textContent, "Constructed");
    app.document.querySelector('[data-filter-open=format]').click();
    const options = [...app.document.querySelectorAll('#filterOptionList input[type=checkbox]')];
    assert.equal(options.length, 1);
    assert.equal(options[0].checked, true);
  } finally {
    app.close();
  }
});

test("archived items display Archived on card and detail buttons, but still support restoring", async () => {
  const app = await setup({ archived: true });
  try {
    const cardButton = app.document.querySelector('.result-card [data-state="archived"]');
    assert.equal(cardButton.textContent, "Archived");
    assert.equal(cardButton.getAttribute("aria-label"), "Restore from archive");
    assert.equal(cardButton.dataset.value, "false");
    app.document.querySelector(".card-title a").click();
    await app.settle();
    const detailButton = app.document.querySelector('#detailView [data-state="archived"]');
    assert.equal(detailButton.textContent, "Archived");
    detailButton.click();
    await app.settle();
    assert.equal(app.document.querySelector('#detailView [data-state="archived"]').textContent, "Archive");
    const request = app.calls.filter(([url]) => url === '/api/catalogue/event/e1/state').at(-1);
    assert.equal(JSON.parse(request[1].body).archived, false);
  } finally {
    app.close();
  }
});

test("dark-mode event card contrast is scoped to dark theme", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /:root\[data-theme="dark"\] \.result-card\s*\{[^}]*background:\s*#[a-f0-9]{6}/);
  assert.match(styles, /:root\[data-theme="dark"\] \.result-card:hover/);
});

test("event cards reflect saved states without duplicating the action labels as tags", async () => {
  const cases = [
    [{}, null],
    [{ bookmarked: true }, null],
    [{ watching: true }, "event-card--watching"],
    [{ joined: true }, "event-card--joined"],
    [{ joined: true, watching: true }, "event-card--joined"],
    [{ archived: true }, "event-card--archived"],
    [{ archived: true, watching: true, joined: true }, "event-card--archived"],
  ];
  for (const [flags, expected] of cases) {
    const app = await setup(flags);
    try {
      const card = app.document.querySelector(".result-card");
      assert.ok(card);
      const states = ["event-card--archived", "event-card--joined", "event-card--watching"];
      assert.deepEqual(states.filter(value => card.classList.contains(value)), expected ? [expected] : []);
      // State is already legible in the Save/Watching/Joined/Archived buttons.
      const tags = card.querySelector(".card-tags").textContent;
      assert.doesNotMatch(tags, /Joined|Archived|Watching|Saved/);
      if (flags.archived)
        assert.equal(card.querySelector('[data-state="archived"]').textContent, "Archived");
      if (flags.joined)
        assert.match(card.querySelector('[data-state="joined"]').textContent, /Joined/);
      if (flags.watching)
        assert.match(card.querySelector('[data-state="watching"]').textContent, /Watching/);
    } finally {
      app.close();
    }
  }
});

test("event card highlights update immediately when Watch or Archive is toggled", async () => {
  const app = await setup();
  try {
    app.document.querySelector('.result-card [data-state="watching"]').click();
    await app.settle();
    assert.equal(app.document.querySelector(".result-card").classList.contains("event-card--watching"), true);
    app.document.querySelector('.result-card [data-state="archived"]').click();
    await app.settle();
    const archived = app.document.querySelector(".result-card");
    assert.equal(archived.classList.contains("event-card--archived"), true);
    assert.equal(archived.classList.contains("event-card--watching"), false);
    assert.equal(archived.querySelector('[data-state="archived"]').textContent, "Archived");
  } finally {
    app.close();
  }
});

test("state border and fade rules are scoped to event cards", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.result-card\.event-card--joined[^}]*border-color:\s*var\(--event-joined-border\)/);
  assert.match(styles, /\.result-card\.event-card--watching[^}]*border-color:\s*var\(--event-watching-border\)/);
  assert.match(styles, /\.result-card\.event-card--archived[^}]*background:/);
  assert.match(styles, /\.result-card\.event-card--archived \.card-body\s*\{[^}]*opacity:/);
});

test("compact event cards separate metadata chips from price and player statistics", async () => {
  const app = await setup({ eventOverrides: {
    title: "Radiance Pre-Rift Event | RamCards",
    host_lgs: "RamCards",
    format: "LIMITED_SEALED",
    category: "PRE_RIFT",
    price_minor: 3000,
    currency: "EUR",
    capacity: 16,
    current_players: 13,
  } });
  try {
    const card = app.document.querySelector(".result-card");
    assert.equal(card.querySelector(".card-title a").textContent, "Radiance Pre-Rift Event");
    assert.equal(card.querySelectorAll(".card-fact").length, 2);
    assert.match(card.querySelector(".card-facts").textContent, /RamCards/);
    assert.match(card.querySelector(".card-facts").textContent, /London/);
    assert.deepEqual([...card.querySelectorAll(".card-tags .tag")].map(el => el.textContent),
      ["Limited Sealed", "Pre Rift"]);
    const metrics = [...card.querySelectorAll(".card-metric")].map(el =>
      [el.querySelector("dt").textContent, el.querySelector("dd").textContent]);
    assert.equal(metrics.length, 2);
    assert.equal(metrics[0][0], "Entry fee");
    assert.match(metrics[0][1], /30/);
    assert.equal(metrics[1][0], "Players");
    assert.equal(metrics[1][1], "13 / 16");
    assert.equal(card.querySelector(".card-metrics progress"), null);
    assert.equal(card.querySelector(".card-metrics [role=progressbar]"), null);
    assert.equal(card.querySelector(".card-top").lastElementChild.classList.contains("status"), true);
  } finally { app.close(); }
});

test("event facts gracefully omit unpublished price or player counts", async () => {
  const app = await setup();
  try {
    const card = app.document.querySelector(".result-card");
    assert.equal(card.querySelector(".card-metrics"), null);
    assert.equal(card.querySelector(".card-tags").textContent, "");
    assert.equal(card.querySelector(".card-facts .card-fact-subline").textContent, "London, United Kingdom");
  } finally { app.close(); }
});

test("event action footer keeps Watch primary and Archive accessible via the overflow menu", async () => {
  const app = await setup();
  try {
    let card = app.document.querySelector(".result-card");
    const buttons = [...card.querySelectorAll(".card-actions--event > button")];
    assert.deepEqual(buttons.map(el => el.dataset.state), ["bookmarked", "watching", "joined"]);
    assert.equal(card.querySelector(".card-watch").getAttribute("aria-pressed"), "false");
    const more = card.querySelector(".card-more");
    assert.ok(more);
    assert.equal(more.open, false);
    more.querySelector("summary").click();
    assert.equal(more.open, true);
    assert.equal(more.querySelector('[data-state=archived]').textContent, "Archive");
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(more.open, false);
    more.querySelector("summary").click();
    more.querySelector('[data-state=archived]').click();
    await app.settle();
    card = app.document.querySelector(".result-card");
    assert.equal(card.classList.contains("event-card--archived"), true);
    assert.equal(card.querySelector(".card-more [data-state=archived]").textContent, "Archived");
    assert.equal(JSON.parse(app.calls.filter(([url]) => url.endsWith("/state")).at(-1)[1].body).archived, true);
  } finally { app.close(); }
});

test("long availability messages retain a rightmost dot and titles have no arrow", async () => {
  const app = await setup({ eventOverrides: { status: "NOT_OPEN", title: "Long Event Title" } });
  try {
    const card = app.document.querySelector(".result-card");
    const status = card.querySelector(".card-top .status");
    assert.equal(status.textContent, "Not open yet");
    assert.equal(status.parentElement.lastElementChild, status);
    const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    assert.match(styles, /\.card-top \.status::after\s*\{[^}]*content:\s*""/);
    assert.match(styles, /\.card-top \.status\s*\{[^}]*text-align:\s*right/);
    assert.match(styles, /\.card-top \.status::before\s*\{\s*display:\s*none/);
    assert.doesNotMatch(styles, /\.card-title a:after/);
    assert.match(styles, /\.card-title a:hover/);
  } finally { app.close(); }
});
