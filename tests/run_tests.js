#!/usr/bin/env node
// Model Scout test suite. Run: node tests/run_tests.js
// No dependencies: a tiny runner with assert.
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var S = require("../app.js");

var ROOT = path.join(__dirname, "..");
var NOW = new Date("2026-11-02T12:00:00Z");
var results = { pass: 0, fail: 0, failures: [] };
var group = "";

function section(name) { group = name; console.log("\n" + name); }
function test(name, fn) {
  try { fn(); results.pass++; console.log("  ok   " + name); }
  catch (e) { results.fail++; results.failures.push(group + " > " + name + ": " + e.message); console.log("  FAIL " + name + "\n       " + e.message); }
}
function close(a, b, msg) { assert.ok(Math.abs(a - b) < 1e-9, (msg || "") + " expected " + b + ", got " + a); }

// Synthetic model factory: every field valid, override what a test cares about.
function mk(over) {
  var m = {
    id: "m", model: "Model", provider: "P", kind: "generation", context_window: 1000000,
    input_price_per_mtok: 1, output_price_per_mtok: 4, price_status: "verified", unverified_fields: [],
    latency_class: "medium", quality_tier: 3, task_fit: ["chat", "code", "rag", "vision", "agentic"],
    input_modalities: ["text", "image"], open_weights: false, local_hardware: null,
    strengths: ["s"], limits: ["l"], source: { name: "test", url: "https://example.com" }, last_verified: "2026-11-01"
  };
  Object.keys(over || {}).forEach(function (k) { m[k] = over[k]; });
  return m;
}
function profile(over) {
  var p = { taskType: "chat", budget: null, latency: "balanced", quality: "good", localOnly: false,
    contextNeed: 32000, modality: "text", inputTokens: 50e6, outputTokens: 10e6 };
  Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
  return p;
}
function sumW(w) { return Object.keys(w).reduce(function (s, k) { return s + w[k]; }, 0); }

var catalogText = fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8");
var catalog = JSON.parse(catalogText);
var models = catalog.models;

// ------------------------------------------------------------------
section("Ranking: weights respond to constraints");
test("weights always sum to 1", function () {
  [profile(), profile({ budget: 0.5 }), profile({ localOnly: true, quality: "frontier", latency: "fast", contextNeed: 1e6 }),
   profile({ quality: "basic", latency: "any" })].forEach(function (p) { close(sumW(S.computeWeights(p)), 1, "sum"); });
});
test("tight budget raises the cost weight", function () {
  assert.ok(S.computeWeights(profile({ budget: 0.5 })).cost > S.computeWeights(profile()).cost);
});
test("tighter budget raises cost weight more than a loose budget", function () {
  assert.ok(S.computeWeights(profile({ budget: 0.5 })).cost > S.computeWeights(profile({ budget: 20 })).cost);
});
test("local-only raises the privacy weight", function () {
  assert.ok(S.computeWeights(profile({ localOnly: true })).privacy > S.computeWeights(profile()).privacy);
});
test("large context need raises the context weight", function () {
  assert.ok(S.computeWeights(profile({ contextNeed: 1e6 })).context > S.computeWeights(profile({ contextNeed: 8000 })).context);
});
test("frontier quality bar raises the quality weight", function () {
  assert.ok(S.computeWeights(profile({ quality: "frontier" })).quality > S.computeWeights(profile({ quality: "basic" })).quality);
});
test("fast speed target raises the latency weight", function () {
  assert.ok(S.computeWeights(profile({ latency: "fast" })).latency > S.computeWeights(profile({ latency: "any" })).latency);
});

section("Ranking: outcomes");
var cheap = mk({ id: "cheap", model: "Cheap", input_price_per_mtok: 0.1, output_price_per_mtok: 0.4, quality_tier: 3 });
var pricey = mk({ id: "pricey", model: "Pricey", input_price_per_mtok: 10, output_price_per_mtok: 40, quality_tier: 5 });
test("cheaper model wins under a tight budget", function () {
  var r = S.rankModels([pricey, cheap], profile({ budget: 0.5, quality: "basic" }), NOW);
  assert.strictEqual(r.ranked[0].model.id, "cheap");
});
test("same pair: pricier frontier model wins with no budget and a frontier bar", function () {
  var r = S.rankModels([pricey, cheap], profile({ quality: "frontier" }), NOW);
  assert.strictEqual(r.ranked[0].model.id, "pricey");
});
test("over-budget model is flagged", function () {
  var r = S.rankModels([pricey, cheap], profile({ budget: 0.5 }), NOW);
  var p = r.ranked.filter(function (x) { return x.model.id === "pricey"; })[0];
  assert.ok(p.flags.some(function (f) { return /Over budget/.test(f); }));
});
test("identical models except price: cheaper scores higher", function () {
  var a = mk({ id: "a", input_price_per_mtok: 0.5, output_price_per_mtok: 2 });
  var b = mk({ id: "b", input_price_per_mtok: 5, output_price_per_mtok: 20 });
  var r = S.rankModels([b, a], profile(), NOW);
  assert.strictEqual(r.ranked[0].model.id, "a");
  assert.ok(r.ranked[0].components.cost > r.ranked[1].components.cost);
});
test("short-context model is penalized for a long-context need", function () {
  var shortM = mk({ id: "short", context_window: 128000 });
  var longM = mk({ id: "long", context_window: 1000000 });
  var r = S.rankModels([shortM, longM], profile({ contextNeed: 1000000 }), NOW);
  assert.strictEqual(r.ranked[0].model.id, "long");
  var s = r.ranked[1];
  assert.ok(s.components.context < 0.1, "context score " + s.components.context);
  assert.ok(s.flags.some(function (f) { return /Context too short/.test(f); }));
});
test("short context is not penalized when the need is small", function () {
  var r = S.rankModels([mk({ context_window: 128000 })], profile({ contextNeed: 8000 }), NOW);
  assert.strictEqual(r.ranked[0].components.context, 1);
});
test("local-only excludes hosted-only models", function () {
  var hosted = mk({ id: "hosted", open_weights: false });
  var open = mk({ id: "open", open_weights: true, local_hardware: "workstation" });
  var r = S.rankModels([hosted, open], profile({ localOnly: true }), NOW);
  assert.deepStrictEqual(r.ranked.map(function (x) { return x.model.id; }), ["open"]);
  assert.strictEqual(r.excluded.length, 1);
  assert.ok(/Hosted only/.test(r.excluded[0].excludeReason));
});
test("local-only on the real catalog ranks only open-weight models", function () {
  var r = S.rankModels(models, profile({ localOnly: true }), NOW);
  assert.ok(r.ranked.length > 0);
  r.ranked.forEach(function (x) { assert.ok(x.model.open_weights, x.model.model + " is hosted-only"); });
  assert.ok(r.excluded.some(function (x) { return !x.model.open_weights; }));
});
test("local-only prefers smaller hardware when all else is equal", function () {
  var lap = mk({ id: "lap", open_weights: true, local_hardware: "laptop" });
  var clu = mk({ id: "clu", open_weights: true, local_hardware: "cluster" });
  assert.strictEqual(S.rankModels([clu, lap], profile({ localOnly: true }), NOW).ranked[0].model.id, "lap");
});
test("embeddings task keeps only embedding models", function () {
  var r = S.rankModels(models, profile({ taskType: "embeddings" }), NOW);
  assert.ok(r.ranked.length >= 1);
  r.ranked.forEach(function (x) { assert.strictEqual(x.model.kind, "embedding"); });
});
test("non-embedding tasks exclude embedding models", function () {
  var r = S.rankModels(models, profile({ taskType: "chat" }), NOW);
  r.ranked.forEach(function (x) { assert.notStrictEqual(x.model.kind, "embedding"); });
});
test("models without the required input type are excluded", function () {
  var r = S.rankModels([mk({ id: "t", input_modalities: ["text"] })], profile({ modality: "audio" }), NOW);
  assert.strictEqual(r.ranked.length, 0);
  assert.ok(/audio/.test(r.excluded[0].excludeReason));
});
test("vision task requires image input even if modality is left on text", function () {
  var r = S.rankModels([mk({ id: "t", input_modalities: ["text"] })], profile({ taskType: "vision" }), NOW);
  assert.strictEqual(r.ranked.length, 0);
});
test("frontier bar: a cheap tier-3 model ranks below tier-5 models", function () {
  var r = S.rankModels(models, profile({ taskType: "code", quality: "frontier" }), NOW);
  var firstBelow = r.ranked.findIndex(function (x) { return x.model.quality_tier < 5; });
  var lastTop = -1;
  r.ranked.forEach(function (x, i) { if (x.model.quality_tier === 5) lastTop = i; });
  assert.ok(lastTop < firstBelow, "a below-bar model outranks a frontier model");
});
test("embeddings are not penalized for document length (they work per chunk)", function () {
  var r = S.rankModels(models, profile({ taskType: "embeddings", contextNeed: 1000000 }), NOW);
  r.ranked.forEach(function (x) { assert.strictEqual(x.components.context, 1); });
});
test("a tie is explained as a tie, not as a lead", function () {
  var a = mk({ id: "a", model: "A" }), b = mk({ id: "b", model: "B" });
  var top = S.rankModels([a, b], profile(), NOW).ranked[0];
  assert.ok(/Ties with/.test(top.explain.tradeoffs));
});
test("model not positioned for the task is down-weighted and flagged", function () {
  var gen = mk({ id: "gen" }), coder = mk({ id: "coder", task_fit: ["code"] });
  var r = S.rankModels([coder, gen], profile({ taskType: "chat" }), NOW);
  assert.strictEqual(r.ranked[0].model.id, "gen");
  assert.ok(r.ranked[1].flags.some(function (f) { return /Not positioned/.test(f); }));
});
test("tight budget on the real catalog: top pick fits the budget", function () {
  var p = profile({ budget: 0.5, quality: "basic" });
  var top = S.rankModels(models, p, NOW).ranked[0];
  assert.ok(S.blendedPrice(top.model, p.inputTokens, p.outputTokens) <= 0.5, top.model.model);
});
test("every ranked pick has a plain-language reason and a trade-off", function () {
  var r = S.rankModels(models, profile(), NOW);
  r.ranked.forEach(function (x) {
    assert.ok(x.explain.why.length > 20, x.model.model + " why");
    assert.ok(x.explain.tradeoffs.length > 10, x.model.model + " tradeoffs");
  });
});
test("scores are between 0 and 100 and ranks are sequential", function () {
  var r = S.rankModels(models, profile({ contextNeed: 2000000, latency: "fast" }), NOW);
  r.ranked.forEach(function (x, i) { assert.ok(x.total >= 0 && x.total <= 100); assert.strictEqual(x.rank, i + 1); });
});

section("Switch check");
test("reports a better model and the margin", function () {
  var r = S.switchCheck([pricey, cheap], "pricey", profile({ budget: 0.5 }), NOW);
  assert.strictEqual(r.better.length, 1);
  assert.strictEqual(r.better[0].model.id, "cheap");
  assert.ok(r.better[0].margin > 0);
});
test("reports nothing better for the top pick", function () {
  var top = S.rankModels(models, profile(), NOW).ranked[0].model.id;
  assert.strictEqual(S.switchCheck(models, top, profile(), NOW).better.length, 0);
});
test("reports when the current model fails a hard constraint", function () {
  var r = S.switchCheck([pricey, cheap], "pricey", profile({ localOnly: true }), NOW);
  assert.ok(r.excluded);
});

// ------------------------------------------------------------------
section("Cost math");
test("monthly cost = input x input price + output x output price, per million", function () {
  close(S.monthlyCost(mk({ input_price_per_mtok: 2, output_price_per_mtok: 10 }), 50e6, 10e6), 200);
});
test("one million input tokens at $1 per million costs $1", function () {
  close(S.monthlyCost(mk({ input_price_per_mtok: 1, output_price_per_mtok: 0 }), 1e6, 0), 1);
});
test("per-million scaling for small volumes", function () {
  close(S.monthlyCost(mk({ input_price_per_mtok: 3, output_price_per_mtok: 15 }), 1000, 500), 0.003 + 0.0075);
});
test("zero volume costs zero", function () {
  assert.strictEqual(S.monthlyCost(mk(), 0, 0), 0);
});
test("unknown price gives null, not a made-up number", function () {
  assert.strictEqual(S.monthlyCost(mk({ input_price_per_mtok: null, price_status: "unverified" }), 1e6, 1e6), null);
});
test("blended price follows the input/output mix", function () {
  var m = mk({ input_price_per_mtok: 1, output_price_per_mtok: 5 });
  close(S.blendedPrice(m, 3e6, 1e6), 2);
  close(S.blendedPrice(m, 0, 0), 2); // default 3:1 mix
  close(S.blendedPrice(m, 1e6, 0), 1);
});
test("cost score falls as price rises", function () {
  assert.ok(S.costScoreFromPrice(0.1) > S.costScoreFromPrice(1));
  assert.ok(S.costScoreFromPrice(1) > S.costScoreFromPrice(20));
  assert.strictEqual(S.costScoreFromPrice(0), 1);
});
test("money formatting", function () {
  assert.strictEqual(S.fmtMoney(200), "$200");
  assert.strictEqual(S.fmtMoney(12.5), "$12.50");
  assert.strictEqual(S.fmtMoney(0.001), "under $0.01");
  assert.strictEqual(S.fmtMoney(null), "unknown");
});

// ------------------------------------------------------------------
section("Stale-data flagging");
test("old date is flagged", function () {
  var s = S.staleStatus({ last_verified: "2025-01-01" }, NOW);
  assert.ok(s.stale); assert.ok(s.ageDays > 90);
});
test("missing date is flagged", function () {
  assert.ok(S.staleStatus({}, NOW).stale);
  assert.ok(S.staleStatus({ last_verified: null }, NOW).stale);
});
test("unparseable date is flagged", function () {
  assert.ok(S.staleStatus({ last_verified: "last spring" }, NOW).stale);
});
test("future date is flagged", function () {
  assert.ok(S.staleStatus({ last_verified: "2027-06-01" }, NOW).stale);
});
test("recent date is not flagged", function () {
  var s = S.staleStatus({ last_verified: "2026-10-20" }, NOW);
  assert.ok(!s.stale); assert.strictEqual(s.ageDays, 13);
});
test("90 days old is not stale, 91 days is", function () {
  assert.ok(!S.staleStatus({ last_verified: "2026-08-04" }, NOW).stale);
  assert.ok(S.staleStatus({ last_verified: "2026-08-03" }, NOW).stale);
});
test("live ISO timestamps are accepted", function () {
  assert.ok(!S.staleStatus({ last_verified: "2026-11-02T08:00:00.000Z" }, NOW).stale);
});
test("stale and unverified entries produce UI flags", function () {
  var f = S.dataFlags(mk({ last_verified: null, price_status: "unverified", unverified_fields: ["context_window"] }), NOW);
  assert.ok(f.some(function (x) { return /Stale/.test(x.text); }));
  assert.ok(f.some(function (x) { return /Price not verified/.test(x.text); }));
  assert.ok(f.some(function (x) { return /context window/.test(x.text); }));
  assert.strictEqual(S.dataFlags(mk(), NOW).length, 0);
});
test("the stale threshold in code is 90 days and matches the catalog", function () {
  assert.strictEqual(S.STALE_AFTER_DAYS, 90);
  assert.strictEqual(catalog.stale_after_days, 90);
});

// ------------------------------------------------------------------
section("Catalog validation");
test("catalog.json parses and has a valid catalog date", function () {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(catalog.catalog_date));
  assert.ok(Array.isArray(models) && models.length >= 20, "at least 20 models");
});
test("every entry has every required field", function () {
  models.forEach(function (m) {
    S.REQUIRED_FIELDS.forEach(function (f) { assert.ok(f in m, m.id + " missing " + f); });
  });
});
test("every entry passes validateEntry", function () {
  models.forEach(function (m) { assert.deepStrictEqual(S.validateEntry(m), [], m.id); });
});
test("every entry has a source and a date, or is flagged", function () {
  models.forEach(function (m) {
    var hasSource = m.source && m.source.name && m.source.url;
    var flagged = S.staleStatus(m, NOW).stale || m.price_status === "unverified";
    assert.ok((hasSource && m.last_verified) || flagged, m.id);
  });
});
test("prices are non-negative numbers or explicitly unverified", function () {
  models.forEach(function (m) {
    ["input_price_per_mtok", "output_price_per_mtok"].forEach(function (f) {
      var v = m[f];
      assert.ok((typeof v === "number" && v >= 0) || (v === null && m.price_status === "unverified"), m.id + " " + f);
    });
  });
});
test("ids are unique", function () {
  var seen = {};
  models.forEach(function (m) { assert.ok(!seen[m.id], "duplicate " + m.id); seen[m.id] = 1; });
});
test("covers the major providers", function () {
  ["OpenAI", "Anthropic", "Google", "Meta", "Mistral", "DeepSeek", "xAI"].forEach(function (p) {
    assert.ok(models.some(function (m) { return m.provider === p; }), p);
  });
});
test("every task type has at least one candidate", function () {
  ["chat", "code", "rag", "vision", "embeddings", "agentic"].forEach(function (t) {
    assert.ok(S.rankModels(models, profile({ taskType: t }), NOW).ranked.length > 0, t);
  });
});
test("validateEntry rejects bad entries", function () {
  assert.ok(S.validateEntry(mk({ input_price_per_mtok: -1 })).length > 0, "negative price");
  assert.ok(S.validateEntry(mk({ input_price_per_mtok: "cheap" })).length > 0, "string price");
  assert.ok(S.validateEntry(mk({ input_price_per_mtok: null })).length > 0, "null price not flagged");
  assert.strictEqual(S.validateEntry(mk({ input_price_per_mtok: null, price_status: "unverified" })).length, 0, "null price flagged ok");
  assert.ok(S.validateEntry(mk({ source: {} })).length > 0, "missing source");
  var noDate = mk(); delete noDate.last_verified;
  assert.ok(S.validateEntry(noDate).length > 0, "missing date field");
  assert.ok(S.validateEntry(mk({ last_verified: null })).length > 0, "null date not flagged unverified");
});
test("index.html embedded catalog matches catalog.json (run tests/sync_embedded_catalog.js)", function () {
  var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  var m = html.match(/<script type="application\/json" id="embedded-catalog">([\s\S]*?)<\/script>/);
  assert.ok(m, "embedded block missing");
  assert.deepStrictEqual(JSON.parse(m[1]), catalog);
});

// ------------------------------------------------------------------
section("Live data merge (OpenRouter shape)");
var orSample = [
  { id: "x/known", name: "X: Known", context_length: 500000, pricing: { prompt: "0.000002", completion: "0.000008" },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
  { id: "y/new", name: "Y: New", context_length: 64000, hugging_face_id: "y/New", pricing: { prompt: "0.0000001", completion: "0.0000002" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "y/new:free", name: "Y: New (free)", context_length: 64000, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } },
  { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" }, architecture: { output_modalities: ["text"] } },
  { id: "z/img", name: "Z: Image", pricing: { prompt: "0.000001", completion: "0.000001" }, architecture: { output_modalities: ["image"] } }
];
test("updates bundled prices from live data and records the change", function () {
  var base = [mk({ id: "known", openrouter_id: "x/known", input_price_per_mtok: 1, output_price_per_mtok: 8, context_window: 400000 })];
  var r = S.mergeLive(base, orSample, NOW);
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.models[0].input_price_per_mtok, 2);
  assert.strictEqual(r.models[0].context_window, 500000);
  assert.strictEqual(r.models[0].price_status, "live");
  assert.strictEqual(r.changed.length, 1);
  assert.strictEqual(base[0].input_price_per_mtok, 1, "bundled entry not mutated");
});
test("live-only models skip free, router, negative-price, and non-text entries, and are unrated", function () {
  var r = S.mergeLive([], orSample, NOW);
  var ids = r.liveOnly.map(function (m) { return m.openrouter_id; }).sort();
  assert.deepStrictEqual(ids, ["x/known", "y/new"]);
  var y = r.liveOnly.filter(function (m) { return m.openrouter_id === "y/new"; })[0];
  assert.strictEqual(y.quality_tier, null);
  assert.strictEqual(y.open_weights, true);
  assert.deepStrictEqual(S.validateEntry(y), []);
  assert.ok(S.dataFlags(y, NOW).some(function (f) { return /Quality not rated/.test(f.text); }));
});
test("empty or bad live data leaves the catalog unchanged", function () {
  var base = [mk({ openrouter_id: "x/known" })];
  assert.deepStrictEqual(S.mergeLive(base, null, NOW).models, base);
});

section("Task description hints");
test("keywords map to settings", function () {
  var s = S.suggestFromText("Private agent that refactors our whole codebase, must be cheap").settings;
  assert.strictEqual(s.taskType, "agentic");
  assert.strictEqual(s.localOnly, true);
  assert.strictEqual(s.budget, 1);
  assert.strictEqual(s.contextNeed, 400000);
  assert.strictEqual(S.suggestFromText("semantic search over vectors").settings.taskType, "embeddings");
  assert.strictEqual(S.suggestFromText("").why.length, 0);
});

// ------------------------------------------------------------------
section("Static checks: paths, copy, secrets");
var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
test("every asset reference in index.html is relative", function () {
  var refs = [], re = /\b(?:src|href)\s*=\s*"([^"]*)"/g, m;
  while ((m = re.exec(html))) refs.push(m[1]);
  assert.ok(refs.length > 0);
  refs.forEach(function (r) {
    assert.ok(r[0] !== "/", "absolute path: " + r);
    assert.ok(!/^[a-z]+:/i.test(r), "external or scheme URL: " + r);
  });
  ["styles.css", "app.js"].forEach(function (a) { assert.ok(refs.indexOf(a) >= 0, a + " not referenced"); });
});
test("app.js fetches only relative catalog.json and the public OpenRouter list", function () {
  var js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(/fetch\("catalog\.json"/.test(js));
  var urls = js.match(/https?:\/\/[^\s"')]+/g) || [];
  urls.forEach(function (u) { assert.ok(/^https:\/\/openrouter\.ai\//.test(u), "unexpected URL in app.js: " + u); });
});
test("no external fonts, frameworks, or trackers", function () {
  var css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.ok(!/@import|url\(/.test(css), "styles.css loads external resources");
  assert.ok(!/<script[^>]+src="https?:/i.test(html) && !/<link[^>]+href="https?:/i.test(html));
});
test("no em dashes in user-facing files", function () {
  ["index.html", "app.js", "catalog.json", "styles.css"].forEach(function (f) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").indexOf("—") < 0, f);
  });
});
test("no secrets or API keys in the repo files", function () {
  var re = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})/;
  ["index.html", "app.js", "catalog.json", "styles.css", "CLAUDE.md"].forEach(function (f) {
    var p = path.join(ROOT, f);
    if (fs.existsSync(p)) assert.ok(!re.test(fs.readFileSync(p, "utf8")), f);
  });
});

// ------------------------------------------------------------------
section("UI: structure, assets, accessibility (static, no browser)");
var appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
var css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
var pageHtml = html.replace(/<script type="application\/json" id="embedded-catalog">[\s\S]*?<\/script>/, "");
function htmlIds() {
  var ids = {}, re = /\sid="([^"]+)"/g, m;
  while ((m = re.exec(html))) ids[m[1]] = (ids[m[1]] || 0) + 1;
  return ids;
}
function jsIds() {
  // $("id"), tokens("id"), getElementById("id"), and the "<field>-error" helpers built in validateFields
  var out = {}, re = /(?:\$|tokens|getElementById)\("([a-z][a-z0-9-]*)"\)/g, m;
  while ((m = re.exec(appJs))) out[m[1]] = true;
  var vf = appJs.match(/function validateFields\(\)[\s\S]*?\n  \}/);
  assert.ok(vf, "validateFields not found");
  (vf[0].match(/\["([a-z-]+)", "/g) || []).forEach(function (s) { var id = s.slice(2, -4); out[id] = true; out[id + "-error"] = true; });
  return Object.keys(out);
}
function controls() {
  var list = [], re = /<(input|select|textarea)\b([^>]*)>/g, m;
  while ((m = re.exec(pageHtml))) {
    var id = (m[2].match(/\sid="([^"]+)"/) || [])[1];
    list.push({ tag: m[1], id: id, attrs: m[2] });
  }
  return list;
}

test("every element ID used by app.js exists exactly once in index.html", function () {
  var ids = htmlIds(), used = jsIds();
  assert.ok(used.length >= 25, "expected to find the app.js IDs, found " + used.length);
  used.forEach(function (id) {
    assert.ok(ids[id], "missing id in index.html: " + id);
    assert.strictEqual(ids[id], 1, "duplicate id: " + id);
  });
});
test("no duplicate IDs anywhere in index.html", function () {
  var ids = htmlIds();
  Object.keys(ids).forEach(function (id) { assert.strictEqual(ids[id], 1, "duplicate id: " + id); });
});
test("every profile field from v1 is still in the form", function () {
  var form = pageHtml.match(/<form id="profile"[\s\S]*?<\/form>/);
  assert.ok(form, "form#profile missing");
  ["task-desc", "suggest", "task-type", "budget", "latency", "quality", "context-need", "modality", "local-only", "vol-in", "vol-out"]
    .forEach(function (id) { assert.ok(form[0].indexOf('id="' + id + '"') >= 0, id + " not inside the form"); });
  assert.ok(/id="context-need"[\s\S]*?value="32000" selected/.test(form[0]), "32K default lost");
  assert.ok(/id="vol-in"[^>]*value="50"/.test(form[0]) && /id="vol-out"[^>]*value="10"/.test(form[0]), "volume defaults lost");
});
test("every relative asset reference resolves to a file in the repo", function () {
  var re = /\b(?:src|href)\s*=\s*"([^"#][^"]*)"/g, m, n = 0;
  while ((m = re.exec(html))) {
    var ref = m[1].split(/[?#]/)[0];
    assert.ok(!/^\/|^[a-z]+:/i.test(ref), "absolute or external path: " + ref);
    assert.ok(fs.existsSync(path.join(ROOT, ref)), "broken asset reference: " + ref);
    n++;
  }
  assert.ok(n >= 2);
  assert.ok(!/url\(/.test(css), "styles.css must not reference files");
});
test("every in-page link points at an element that exists", function () {
  var ids = htmlIds(), re = /href="#([^"]+)"/g, m;
  while ((m = re.exec(pageHtml))) assert.ok(ids[m[1]], "dead in-page link: #" + m[1]);
  assert.ok(/href="#card-'/.test(appJs), "table rows link to their cards");
  assert.ok(/id="card-'/.test(appJs), "cards carry the matching id");
});
test("every form control has a visible label (label for=id)", function () {
  var list = controls();
  assert.ok(list.length >= 12, "expected at least 12 controls, found " + list.length);
  list.forEach(function (c) {
    assert.ok(c.id, c.tag + " without an id");
    var re = new RegExp('<label[^>]*\\sfor="' + c.id + '"[^>]*>([\\s\\S]*?)</label>');
    var lm = pageHtml.match(re);
    assert.ok(lm, "no label for #" + c.id);
    assert.ok(lm[1].replace(/<[^>]+>/g, "").trim().length > 3, "empty label for #" + c.id);
  });
});
test("aria-describedby targets exist (helper text and inline errors)", function () {
  var ids = htmlIds(), re = /aria-describedby="([^"]+)"/g, m, n = 0;
  while ((m = re.exec(pageHtml))) m[1].split(/\s+/).forEach(function (id) { n++; assert.ok(ids[id], "missing describedby target: " + id); });
  assert.ok(n >= 6);
  ["budget", "vol-in", "vol-out"].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"[^>]*aria-describedby="[^"]*' + id + '-error').test(pageHtml), id + " error not tied to its field");
  });
});
test("buttons have text labels, not icons only", function () {
  var re = /<button\b[^>]*>([\s\S]*?)<\/button>/g, m, n = 0;
  while ((m = re.exec(pageHtml))) { n++; assert.ok(m[1].replace(/<[^>]+>/g, "").trim().length > 3, "button without text"); }
  assert.ok(n >= 1);
});
test("skip link is the first element in body and targets the results section", function () {
  var body = pageHtml.split(/<body[^>]*>/)[1].trim();
  assert.ok(/^<a class="skip" href="#results">Skip to results<\/a>/.test(body), "skip link must come first");
  assert.ok(/<section id="results"[^>]*tabindex="-1"/.test(pageHtml), "results should accept focus from the skip link");
  assert.ok(/\.skip:focus\s*\{[^}]*translateY\(0\)/.test(css), "skip link must become visible on focus");
});
test("zoom is never disabled and the page declares light and dark", function () {
  var vp = pageHtml.match(/<meta name="viewport" content="([^"]+)"/);
  assert.ok(vp && /width=device-width/.test(vp[1]));
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(vp[1]), "zoom disabled");
  assert.ok(/<html lang="en">/.test(pageHtml));
  assert.ok(/@media \(prefers-color-scheme: dark\)/.test(css), "dark mode dropped");
});
test("focus rings are visible and never removed without a replacement", function () {
  assert.ok(/:focus-visible\s*\{\s*outline:\s*3px solid var\(--focus\)/.test(css), "global focus-visible ring missing");
  var re = /([^{}]+)\{([^}]*outline:\s*(?:none|0)\b[^}]*)\}/g, m;
  while ((m = re.exec(css))) {
    var sel = m[1].trim();
    assert.ok(/:focus\b/.test(sel) && !/focus-visible/.test(sel), "outline removed on: " + sel);
    var visible = sel.replace(/:focus\b/, ":focus-visible");
    assert.ok(css.indexOf(visible) >= 0, "no focus-visible replacement for " + sel);
  }
});
test("touch targets: buttons, inputs, selects, nav links, and checkbox labels are at least 44px tall", function () {
  [/\.btn, button \{[^}]*min-height: 44px/, /input\[type="number"\], select, textarea \{[^}]*min-height: 44px/,
   /\.sections a \{[^}]*min-height: 44px/, /\.check label \{[^}]*min-height: 44px/, /\.disclose summary \{[^}]*min-height: 44px/,
   /\.skip \{[^}]*min-height: 44px/].forEach(function (re) { assert.ok(re.test(css), "missing 44px target: " + re); });
});
test("colors are semantic tokens: no raw hex outside the two :root token blocks", function () {
  var blocks = css.match(/:root \{[^}]*\}/g) || [];
  assert.ok(blocks.length >= 3, "token blocks missing");
  var rest = css;
  blocks.forEach(function (b) { rest = rest.replace(b, ""); });
  var hex = rest.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepStrictEqual(hex, [], "raw hex outside tokens");
  assert.ok(!/rgba?\(/.test(rest), "raw rgb outside tokens");
  assert.ok(!/gradient\(/.test(css), "no decorative gradients");
});

// WCAG contrast from the token blocks, both modes.
function tokens(block) {
  var t = {}, re = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g, m;
  while ((m = re.exec(block))) t[m[1]] = m[2];
  return t;
}
function lum(hex) {
  var c = [1, 3, 5].map(function (i) {
    var v = parseInt(hex.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
var lightTokens = tokens(css.match(/^:root \{[^}]*\}/m)[0]);
var darkTokens = tokens(css.match(/prefers-color-scheme: dark\)\s*\{\s*:root \{[^}]*\}/)[0]);
var TEXT_PAIRS = [
  ["text", "bg"], ["text", "surface"], ["text", "surface-2"], ["text", "accent-soft"],
  ["muted", "bg"], ["muted", "surface"], ["muted", "surface-2"], ["muted", "accent-soft"],
  ["accent-text", "bg"], ["accent-text", "surface"], ["accent-text", "accent-soft"],
  ["on-accent", "accent"], ["on-accent", "accent-hover"],
  ["ok", "ok-soft"], ["warn", "warn-soft"], ["warn", "surface"], ["warn", "bg"], ["live", "live-soft"]
];
[["light", lightTokens], ["dark", darkTokens]].forEach(function (mode) {
  test("text contrast is at least 4.5:1 in " + mode[0] + " mode", function () {
    TEXT_PAIRS.forEach(function (pr) {
      var t = mode[1];
      assert.ok(t[pr[0]] && t[pr[1]], "token missing: " + pr.join(" / "));
      var r = contrast(t[pr[0]], t[pr[1]]);
      assert.ok(r >= 4.5, pr[0] + " on " + pr[1] + " is " + r.toFixed(2) + ":1");
    });
  });
  test("focus ring and accent border are at least 3:1 against the page in " + mode[0] + " mode", function () {
    var t = mode[1];
    ["bg", "surface"].forEach(function (b) {
      assert.ok(contrast(t.focus, t[b]) >= 3, "focus on " + b);
      assert.ok(contrast(t.accent, t[b]) >= 3, "accent on " + b);
    });
  });
});

test("type scale: base 16px with 1.5 line height, nothing below 12px", function () {
  assert.ok(/body \{[^}]*font-size: 1rem;[^}]*line-height: 1\.5;/.test(css));
  var re = /font-size:\s*([0-9.]+)(rem|px|em)\b/g, m;
  while ((m = re.exec(css))) {
    var px = m[2] === "px" ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
    if (m[2] === "em" && parseFloat(m[1]) < 1) continue; // relative to a larger heading (section numbers)
    assert.ok(px >= 12, "font-size under 12px: " + m[0]);
  }
});
test("system font stacks only: serif headings, sans UI, mono figures with tabular numbers", function () {
  assert.ok(!/@font-face|@import/.test(css));
  assert.ok(/--font-serif:[^;]*serif;/.test(css) && /--font-sans:[^;]*system-ui/.test(css) && /--font-mono:[^;]*monospace;/.test(css));
  assert.ok(/h1, h2, h3 \{[^}]*font-family: var\(--font-serif\)/.test(css));
  assert.ok(/\.figure-value \{[^}]*font-variant-numeric: tabular-nums/.test(css));
});
test("motion: reduced-motion respected, width and height never animated, durations vary", function () {
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation: none !important/.test(css));
  (css.match(/transition(?:-property)?:[^;]*;/g) || []).forEach(function (t) {
    assert.ok(!/\b(width|height|all)\b/.test(t), "animates layout: " + t);
  });
  (css.match(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g) || []).forEach(function (k) {
    assert.ok(!/\b(width|height)\s*:/.test(k), "keyframes animate size: " + k);
  });
  var durations = {};
  (css.match(/--t-[a-z]+:\s*\d+ms/g) || []).forEach(function (d) { durations[d.split(":")[1].trim()] = true; });
  assert.ok(Object.keys(durations).length >= 3, "use different durations for different changes");
  assert.ok(/state\.lastOrder/.test(appJs), "reveal only when the ranking order changes");
});
test("responsive: no fixed pixel container widths, table stacks into cards on narrow screens", function () {
  assert.ok(!/(?:^|[^-])width:\s*\d{3,}px/m.test(css), "fixed pixel width");
  assert.ok(/\.wrap \{[^}]*max-width: [0-9.]+rem/.test(css));
  var stack = css.match(/@media \(max-width: 59\.99em\) \{[\s\S]*?\n\}/);
  assert.ok(stack, "narrow-screen table rule missing");
  assert.ok(/table\.compare, \.compare tbody, \.compare tr, \.compare td/.test(stack[0]) && /display: block/.test(stack[0]));
  assert.ok(/content: attr\(data-label\)/.test(stack[0]), "stacked cells must show their column name");
  assert.ok(/\.table-wrap \{ overflow: visible/.test(stack[0]), "no sideways scroll on phones");
});
test("every comparison column has a data-label that matches the table header", function () {
  var heads = (pageHtml.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th scope="col">([^<]+)<\/th>/g) || [])
    .map(function (h) { return h.replace(/<[^>]+>/g, ""); });
  assert.strictEqual(heads.length, 12);
  var cols = appJs.match(/var COLUMNS = (\[[^\]]+\]);/);
  assert.ok(cols, "COLUMNS missing");
  assert.deepStrictEqual(JSON.parse(cols[1]), heads);
  var tdCalls = appJs.match(/td\(\d+,/g) || [];
  assert.ok(tdCalls.length >= 6, "cells built through td()");
});
test("loading, empty, and error states exist in the markup and the UI code", function () {
  assert.ok(/id="data-status"[^>]*data-state="loading"/.test(pageHtml), "status starts in loading state");
  assert.ok(/id="top-pick"[^>]*aria-busy="true"/.test(pageHtml), "top pick starts busy");
  assert.ok(/<tbody id="compare-body">\s*<tr class="placeholder">/.test(pageHtml), "table reserves a loading row");
  assert.ok(/\.top-pick \{[^}]*min-height:/.test(css) && /\.status \{[^}]*min-height:/.test(css), "space reserved");
  assert.ok(/No model fits every hard constraint/.test(appJs) && /cards-empty/.test(appJs) && /empty-row/.test(appJs));
  assert.ok(/data-state", "error"/.test(appJs) && /"offline"/.test(appJs));
});
test("winner treatment: best pick marker on the headline, table row, and card", function () {
  assert.ok(/var BEST_FLAG = '<span class="best-flag">/.test(appJs) && /Best pick<\/span>'/.test(appJs));
  assert.ok(/pick-tag">Best pick</.test(appJs));
  assert.ok(/\.card\.is-top \{[^}]*border: 2px solid var\(--accent\)/.test(css));
  assert.ok(/\.top-pick \{[^}]*border: 2px solid var\(--accent\)/.test(css));
  assert.ok(/<svg[^>]*aria-hidden="true"/.test(appJs), "decorative icon hidden from screen readers");
});
test("honesty copy is still on the page", function () {
  ["editorial estimates", "not benchmark scores", "bundled catalog", "* means that figure is not verified", "says so at the top",
   "not reviewed: quality and speed not rated"].forEach(function (s) { assert.ok(pageHtml.indexOf(s) >= 0, "missing: " + s); });
  ["Stale", "Offline", "Live data unavailable", "Using the bundled catalog dated", "Partly unverified"].forEach(function (s) {
    assert.ok(appJs.indexOf(s) >= 0, "app.js lost: " + s);
  });
});
test("no emoji used as icons in the page or the UI code", function () {
  var re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}]/u;
  assert.ok(!re.test(pageHtml), "emoji in index.html");
  assert.ok(!re.test(appJs), "emoji in app.js");
});
test("app.js keeps the engine-then-UI layout (engine exported before any DOM code)", function () {
  var exp = appJs.indexOf("module.exports = api"), dom = appJs.indexOf("document.getElementById");
  assert.ok(exp > 0 && dom > exp, "engine export must come before browser UI");
  assert.ok(/if \(typeof document === "undefined"\) return;/.test(appJs));
});

// ------------------------------------------------------------------
// DOM smoke tests run in a child process (they are async and need jsdom, which is optional).
section("DOM smoke tests (jsdom, see tests/dom_smoke.js)");
(function () {
  var r = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "dom_smoke.js")], { encoding: "utf8", env: process.env, timeout: 120000 });
  var out = (r.stdout || "") + (r.stderr || "");
  if (/^SKIP/m.test(out)) { console.log("  skip jsdom not installed (set NODE_PATH to a node_modules with jsdom to run them)"); return; }
  out.split("\n").filter(function (l) { return /^ {2}(ok|FAIL)| {7}/.test(l); }).forEach(function (l) { console.log(l); });
  var m = out.match(/(\d+) passed, (\d+) failed/);
  if (!m || r.status !== 0) {
    var failed = m ? parseInt(m[2], 10) : 1;
    results.fail += failed;
    results.failures.push("DOM smoke: " + (m ? failed + " failed" : "did not finish: " + out.slice(-300)));
  }
  if (m) results.pass += parseInt(m[1], 10);
})();

// ------------------------------------------------------------------
console.log("\n" + results.pass + " passed, " + results.fail + " failed, " + (results.pass + results.fail) + " total");
if (results.fail) { console.log(results.failures.join("\n")); process.exit(1); }
