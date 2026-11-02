#!/usr/bin/env node
// Model Scout DOM smoke tests: load index.html + app.js in jsdom and drive the page like a user.
// Optional dependency: jsdom is not part of the repo. Run with it on the module path, for example
//   NODE_PATH=/path/to/node_modules node tests/run_tests.js
// Without jsdom this prints SKIP and exits 0. jsdom has no layout engine: this checks behavior and
// structure, not pixels.
"use strict";
var fs = require("fs");
var path = require("path");
var JSDOM;
try { JSDOM = require("jsdom").JSDOM; } catch (e) { console.log("SKIP jsdom not installed: DOM smoke tests not run"); process.exit(0); }

var ROOT = path.join(__dirname, "..");
var HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace('<script src="app.js"></script>', "");
var APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
var CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
var OR_URL = "https://openrouter.ai/api/v1/models";
var results = { pass: 0, fail: 0, failures: [] };

function ok(cond, msg) { if (!cond) throw new Error(msg); }
function resp(obj, status) {
  return Promise.resolve({ ok: !status || status < 400, status: status || 200, json: function () { return Promise.resolve(obj); } });
}
function orSample() {
  var first = CATALOG.models.filter(function (m) { return m.openrouter_id; })[0];
  return { data: [
    { id: first.openrouter_id, name: "X: " + first.model, context_length: first.context_window,
      pricing: { prompt: String(first.input_price_per_mtok / 2e6), completion: String(first.output_price_per_mtok / 2e6) },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "acme/live-only-1", name: "Acme: Live Only One", context_length: 64000, pricing: { prompt: "0.0000002", completion: "0.0000004" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] } }
  ] };
}
function staleCatalog() {
  var c = JSON.parse(JSON.stringify(CATALOG));
  c.catalog_date = "2026-01-15";
  c.models.forEach(function (m) { m.last_verified = "2026-01-15"; });
  return c;
}

function boot(opts) {
  var dom = new JSDOM(HTML, { url: opts.url || "http://localhost:8000/model-scout/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  var w = dom.window, calls = [];
  w.fetch = function (url) {
    calls.push(String(url));
    if (String(url) === OR_URL) return opts.openrouter ? opts.openrouter() : Promise.reject(new TypeError("Failed to fetch"));
    if (String(url) === "catalog.json") return opts.catalog ? opts.catalog() : resp(CATALOG);
    return Promise.reject(new Error("unexpected fetch " + url));
  };
  w.eval(APP);
  return { w: w, d: w.document, calls: calls, $: function (id) { return w.document.getElementById(id); } };
}
function waitFor(fn, label) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      var v; try { v = fn(); } catch (e) { v = false; }
      if (v) return resolve(v);
      if (Date.now() - start > 4000) return reject(new Error("timed out waiting for " + label));
      setTimeout(poll, 10);
    })();
  });
}
function fire(p, id, type) { p.$(id).dispatchEvent(new p.w.Event(type || "input", { bubbles: true })); }
function settled(p) { return waitFor(function () { return !/Checking OpenRouter/.test(p.$("data-status").textContent) && p.$("data-status").getAttribute("data-state") !== "loading"; }, "live check to finish"); }

function checkRanking(p, label) {
  var rows = p.d.querySelectorAll("#compare-body tr");
  var cards = p.d.querySelectorAll("#cards .card");
  ok(rows.length > 0 && rows.length === cards.length, label + ": table rows (" + rows.length + ") match cards (" + cards.length + ")");
  ok(rows[0].classList.contains("is-top") && /Best pick/.test(rows[0].textContent), label + ": first row is the best pick");
  ok(p.d.querySelectorAll("#cards .card.is-top").length === 1, label + ": exactly one winner card");
  ok(p.$("top-pick").querySelector(".best-flag") && p.$("top-pick").querySelector(".figure-value.cost"), label + ": headline has marker and cost figure");
  ok(p.$("top-pick").getAttribute("aria-busy") === "false", label + ": headline no longer busy");
  Array.prototype.forEach.call(rows, function (tr) {
    var tds = tr.querySelectorAll("td");
    ok(tds.length === 11 && tr.querySelectorAll("th").length === 1, label + ": 12 cells per row");
    Array.prototype.forEach.call(tds, function (td) { ok(td.getAttribute("data-label"), label + ": cell without data-label"); });
  });
  ok(/\d+ ranked, \d+ excluded/.test(p.$("result-count").textContent), label + ": result count");
  ok(p.d.querySelectorAll("#weights li").length === 5, label + ": five weights");
}

var cases = [];
function test(name, fn) { cases.push({ name: name, fn: fn }); }

test("loading state: status, headline, and table show loading until the catalog arrives", function () {
  var release;
  var p = boot({ catalog: function () { return new Promise(function (r) { release = function () { r({ ok: true, status: 200, json: function () { return Promise.resolve(CATALOG); } }); }; }); } });
  ok(p.$("data-status").getAttribute("data-state") === "loading", "status not loading");
  ok(/Loading the model catalog/.test(p.$("data-status").textContent), "no loading text");
  ok(p.$("data-status").querySelector(".spinner"), "no loading indicator");
  ok(p.$("top-pick").getAttribute("aria-busy") === "true", "headline not busy");
  ok(/Loading rankings/.test(p.$("compare-body").textContent), "table has no loading row");
  ok(p.$("include-live").disabled, "live toggle enabled too early");
  return waitFor(function () { return release; }, "catalog request").then(function () {
    release();
    return waitFor(function () { return p.d.querySelectorAll("#cards .card").length; }, "first render");
  }).then(function () { checkRanking(p, "after load"); return settled(p); });
});

test("live fetch from a subpath: live prices merged, live-only toggle works", function () {
  var p = boot({ url: "https://battlettt.github.io/model-scout/", openrouter: function () { return resp(orSample()); } });
  return settled(p).then(function () {
    var st = p.$("data-status");
    ok(st.getAttribute("data-state") === "live", "state " + st.getAttribute("data-state"));
    ok(/OpenRouter model list fetched/.test(st.textContent) && /1 catalog models updated/.test(st.textContent), "live summary: " + st.textContent);
    ok(p.calls.indexOf("catalog.json") >= 0, "catalog.json fetched relatively");
    ok(!p.$("include-live").disabled, "live toggle still disabled");
    ok(/1 unreviewed live models/.test(p.$("include-live-help").textContent), "live help text");
    ok(/Live price/.test(p.$("compare-body").textContent), "live price badge missing");
    checkRanking(p, "live");
    var before = p.d.querySelectorAll("#compare-body tr").length;
    p.$("include-live").checked = true; fire(p, "include-live", "change");
    ok(p.d.querySelectorAll("#compare-body tr").length === before + 1, "live-only model not added");
    ok(/Live only/.test(p.$("compare-body").textContent), "live-only badge missing");
  });
});

test("OpenRouter blocked: offline label, bundled catalog used, ranking still works", function () {
  var p = boot({});
  return settled(p).then(function () {
    var st = p.$("data-status");
    ok(st.getAttribute("data-state") === "offline", "state " + st.getAttribute("data-state"));
    ok(/Offline/.test(st.textContent) && /Live data unavailable/.test(st.textContent) && /Using the bundled catalog dated/.test(st.textContent), "offline copy: " + st.textContent);
    ok(p.$("include-live").disabled, "live toggle should stay disabled");
    ok(/Unavailable/.test(p.$("include-live-help").textContent), "help text not updated");
    checkRanking(p, "offline");
  });
});

test("file open: embedded catalog used without fetching catalog.json", function () {
  var p = boot({ url: "file:///home/user/model-scout/index.html" });
  return settled(p).then(function () {
    ok(p.calls.indexOf("catalog.json") < 0, "fetched catalog.json on file://");
    ok(/embedded in index\.html \(opened as a local file\)/.test(p.$("data-status").textContent), "origin not labelled");
    ok(p.$("catalog-date").textContent === CATALOG.catalog_date, "catalog date not shown");
    checkRanking(p, "file");
  });
});

test("catalog.json fails over HTTP: falls back to the embedded copy and says so", function () {
  var p = boot({ catalog: function () { return resp({}, 404); } });
  return settled(p).then(function () {
    ok(/catalog\.json failed: HTTP 404/.test(p.$("data-status").textContent), "fallback reason missing");
    checkRanking(p, "fallback");
  });
});

test("stale catalog: stale badges in status, table, and cards", function () {
  var p = boot({ catalog: function () { return resp(staleCatalog()); }, openrouter: function () { return resp({ data: [] }); } });
  return settled(p).then(function () {
    var st = p.$("data-status");
    ok(st.getAttribute("data-state") === "stale", "state " + st.getAttribute("data-state"));
    ok(/Stale/.test(st.textContent) && /older than 90 days/.test(st.textContent), "stale status copy");
    ok(p.d.querySelectorAll("#compare-body .badge.stale").length === p.d.querySelectorAll("#compare-body tr").length, "every row stale");
    ok(/Stale: Last verified \d+ days ago/.test(p.$("cards").textContent), "card stale flag");
    ok(/Stale:/.test(p.$("top-pick").textContent), "headline stale flag");
  });
});

test("main flow: describe, suggest, adjust constraints, get a ranking, check current model", function () {
  var p = boot({});
  return settled(p).then(function () {
    p.$("task-desc").value = "Private agent that refactors our whole codebase, must be cheap";
    fire(p, "task-desc");
    p.$("suggest").click();
    ok(p.$("task-type").value === "agentic" && p.$("local-only").checked && p.$("budget").value === "1" && p.$("context-need").value === "400000", "suggestions not applied");
    ok(/Updated settings because your description/.test(p.$("suggest-result").textContent), "suggest feedback");
    checkRanking(p, "local agentic");
    var ids = Array.prototype.map.call(p.d.querySelectorAll("#cards .card"), function (c) { return c.id.replace("card-", ""); });
    var byId = {}; CATALOG.models.forEach(function (m) { byId[m.id] = m; });
    ids.forEach(function (id) { ok(byId[id].open_weights, id + " is hosted-only but ranked under local-only"); });
    ok(/Self-hosted/.test(p.$("top-pick").querySelector(".figure-value.cost").textContent), "local cost figure");
    p.$("local-only").checked = false; fire(p, "local-only", "change");
    p.$("quality").value = "frontier"; fire(p, "quality", "change");
    p.$("vol-in").value = "200"; fire(p, "vol-in");
    checkRanking(p, "frontier hosted");
    ok(/^\$/.test(p.$("top-pick").querySelector(".figure-value.cost").textContent), "dollar cost figure");
    var sel = p.$("current-model");
    ok(sel.options.length > 2, "current model options not filled");
    sel.value = sel.options[sel.options.length - 1].value; fire(p, "current-model", "change");
    ok(/scores|fails a hard constraint/.test(p.$("switch-result").textContent), "switch check did not run");
  });
});

test("empty state: impossible constraints show a clear no-result message everywhere", function () {
  var p = boot({});
  return settled(p).then(function () {
    p.$("modality").value = "audio"; p.$("local-only").checked = true; fire(p, "modality", "change");
    var noAudioLocal = CATALOG.models.every(function (m) { return !(m.open_weights && (m.input_modalities || []).indexOf("audio") >= 0); });
    ok(noAudioLocal, "fixture assumption: catalog has no local audio model");
    ok(p.$("top-pick").classList.contains("is-empty") && /No model fits every hard constraint/.test(p.$("top-pick").textContent), "headline empty state");
    ok(p.d.querySelector("#cards .cards-empty"), "cards empty state");
    ok(p.d.querySelector("#compare-body tr.empty-row"), "table empty row");
    ok(/^0 ranked/.test(p.$("result-count").textContent), "count");
    p.$("modality").value = "text"; p.$("local-only").checked = false; fire(p, "modality", "change");
    ok(!p.$("top-pick").classList.contains("is-empty"), "empty state did not clear");
    checkRanking(p, "recovered");
  });
});

test("incomplete and invalid input: inline errors next to the field, ranking keeps working", function () {
  var p = boot({});
  return settled(p).then(function () {
    p.$("budget").value = "-3"; fire(p, "budget");
    ok(p.$("budget").getAttribute("aria-invalid") === "true", "budget not marked invalid");
    ok(/0 or more/.test(p.$("budget-error").textContent), "budget error text");
    ok(p.$("budget-error").parentNode === p.$("budget").closest(".field"), "error not next to its field");
    checkRanking(p, "negative budget");
    p.$("budget").value = ""; fire(p, "budget");
    ok(!p.$("budget").hasAttribute("aria-invalid") && p.$("budget-error").textContent === "", "budget error not cleared");
    p.$("vol-in").value = ""; p.$("vol-out").value = ""; fire(p, "vol-out");
    ok(p.$("vol-in-error").textContent === "" && p.$("vol-out-error").textContent === "", "empty volume is allowed");
    checkRanking(p, "no volume");
    p.$("vol-out").value = "-1"; fire(p, "vol-out");
    ok(/0 or more million tokens/.test(p.$("vol-out-error").textContent), "volume error text");
    p.$("task-desc").value = "zzz"; p.$("suggest").click();
    ok(/No keywords matched/.test(p.$("suggest-result").textContent), "no-match feedback");
  });
});

test("reveal motion plays only when the ranking order changes", function () {
  var p = boot({});
  return settled(p).then(function () {
    p.$("task-desc").value = "typing should not replay the animation"; fire(p, "task-desc");
    ok(!p.$("cards").classList.contains("is-reveal"), "reveal replayed on a keystroke");
    p.$("quality").value = "frontier"; p.$("latency").value = "any"; fire(p, "quality", "change");
    ok(p.$("cards").classList.contains("is-reveal") && p.$("top-pick").classList.contains("is-reveal"), "reveal not played on reorder");
  });
});

test("accessibility structure: skip link, labelled controls, links into cards", function () {
  var p = boot({});
  return settled(p).then(function () {
    var skip = p.d.body.firstElementChild;
    ok(skip.tagName === "A" && skip.getAttribute("href") === "#results" && p.$("results").getAttribute("tabindex") === "-1", "skip link");
    Array.prototype.forEach.call(p.d.querySelectorAll("input, select, textarea"), function (el) {
      ok(el.labels && el.labels.length > 0 && el.labels[0].textContent.trim().length > 3, "unlabelled control #" + el.id);
    });
    Array.prototype.forEach.call(p.d.querySelectorAll("#compare-body th a"), function (a) {
      ok(p.d.getElementById(a.getAttribute("href").slice(1)), "row link without a card: " + a.getAttribute("href"));
    });
    Array.prototype.forEach.call(p.d.querySelectorAll("#cards svg, #top-pick svg"), function (s) {
      ok(s.getAttribute("aria-hidden") === "true", "svg not hidden from screen readers");
    });
  });
});

(function run(i) {
  if (i >= cases.length) {
    console.log("\n" + results.pass + " passed, " + results.fail + " failed, " + (results.pass + results.fail) + " total");
    if (results.fail) { console.log(results.failures.join("\n")); process.exit(1); }
    process.exit(0);
  }
  var c = cases[i];
  Promise.resolve().then(c.fn).then(function () { results.pass++; console.log("  ok   " + c.name); },
    function (e) { results.fail++; results.failures.push(c.name + ": " + e.message); console.log("  FAIL " + c.name + "\n       " + e.message); })
    .then(function () { run(i + 1); });
})(0);
