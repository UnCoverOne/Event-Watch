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
async function setup({ guest = false, configured = true, slowFilters = false } = {}) {
  const dom = new JSDOM(html, {
    url: "https://event-watch.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let preferences = configured ? { sources: ['uvs', 'play'], country: 'GB', city: '' } : null;
  if (guest && preferences) window.localStorage.setItem('event-watch-browse', JSON.stringify(preferences));
  const calls = [];
  let current = { ...item };
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
      data = { country: ["GB"], format: ["Constructed"], category: ["LOCALS"] };
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
      assert.equal(new URL(query, 'https://test').searchParams.get('city'), 'București');
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
