import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
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
async function setup({ guest = false } = {}) {
  const dom = new JSDOM(html, {
    url: "https://event-watch.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
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
    if (url === "/api/me")
      data = {
        user: guest
          ? null
          : { id: "u", email: "u@example.test", emailVerified: true },
      };
    else if (url === "/api/catalogue/filters")
      data = { country: ["GB"], format: ["Constructed"], category: ["LOCALS"] };
    else if (url === "/api/catalogue/sources") data = { sources: [] };
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
