import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const asset = (path) => readFileSync(new URL("../public/" + path, import.meta.url), "utf8");
const headers = asset("_headers");
const stylesheet = asset("styles.css");

function headerRule(path) {
  const section = headers.split(/\n\s*\n/).find(block => block.split("\n")[0] === path);
  assert.ok(section, "Missing header rule for " + path);
  return section;
}

test("SVG icons are served with the correct MIME type, not the PNG MIME type", () => {
  const generic = headerRule("/icons/*");
  assert.doesNotMatch(generic, /Content-Type\s*:/i, "Do not force a PNG MIME type on all icons");
  assert.match(generic, /Cache-Control: public, max-age=3600/);
  for (const name of ["event-watch-logo.svg", "favicon.svg", "app-icon.svg"]) {
    const specific = headerRule("/icons/" + name);
    assert.match(specific, /Content-Type:\s*image\/svg\+xml/i);
  }
});

test("each SVG icon parses as XML and exposes an SVG root and vector content", () => {
  const dom = new JSDOM("");
  try {
    for (const name of ["event-watch-logo.svg", "favicon.svg", "app-icon.svg"]) {
      const parsed = new dom.window.DOMParser().parseFromString(asset("icons/" + name), "image/svg+xml");
      assert.equal(parsed.getElementsByTagName("parsererror").length, 0, name + " is malformed XML");
      assert.equal(parsed.documentElement.localName, "svg", name);
      assert.ok(parsed.querySelector("path"), name + " has no SVG path");
    }
  } finally {
    dom.window.close();
  }
});

test("logo mask, favicon and service-worker URLs use refreshed icon revisions", () => {
  const html = asset("index.html");
  const detailHtml = asset("detail.html");
  const worker = asset("app.js");
  assert.match(stylesheet, /mask:\s*url\("\/icons\/event-watch-logo\.svg\?v=4"\)/);
  assert.match(html, /href="\/icons\/favicon\.svg\?v=4"/);
  assert.match(detailHtml, /href="\/icons\/favicon\.svg\?v=4"/);
  assert.match(worker, /\/sw\.js\?build=2026-10-08-svg-icon-mime-v1/);
});
