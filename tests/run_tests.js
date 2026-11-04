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
test("app.js calls only relative catalog.json, openrouter.ai, and the local Ollama chat URL", function () {
  var js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(/fetch\("catalog\.json"/.test(js));
  var urls = js.match(/https?:\/\/[^\s"')]+/g) || [];
  urls.forEach(function (u) {
    assert.ok(/^https:\/\/openrouter\.ai\//.test(u) || u === "http://localhost:11434/api/chat", "unexpected URL in app.js: " + u);
  });
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
  ["ok", "ok-soft"], ["warn", "warn-soft"], ["warn", "surface"], ["warn", "bg"], ["live", "live-soft"],
  ["ok", "surface"], ["bg", "text"] // chat status line; selected segment of the provider and mode toggles
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
// Ask a model: chat engine, key box, side by side, ask-this-model. No network: fetch is always stubbed.
// No real key appears in this file: the dummy key is assembled at runtime and is not a valid key format.
var DUMMY_KEY = ["test", "only", "dummy", "value"].join("-");
var VENICE = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
var HERMES = "nousresearch/hermes-3-llama-3.1-70b";
var MSGS = [{ role: "user", content: "Hello" }];

function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}
function blockedStorage() {
  function no() { var e = new Error("denied"); e.name = "SecurityError"; throw e; }
  return { getItem: no, setItem: no, removeItem: no };
}
function jsonRes(obj, status) {
  return { ok: !status || status < 400, status: status || 200, json: function () { return Promise.resolve(obj); } };
}
function badJsonRes() {
  return { ok: true, status: 200, json: function () { return Promise.reject(new SyntaxError("Unexpected token")); } };
}
function textRes(text) {
  return { ok: true, status: 200, text: function () { return Promise.resolve(text); } };
}
function streamRes(chunks) {
  var enc = new TextEncoder(), i = 0, reader = { cancelled: false };
  reader.read = function () {
    return Promise.resolve(i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined });
  };
  reader.cancel = function () { reader.cancelled = true; return Promise.resolve(); };
  return { ok: true, status: 200, reader: reader, body: { getReader: function () { return reader; } } };
}
function orAnswer(text) { return { id: "gen-1", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }; }
function ollamaAnswer(text) { return { model: "dolphin3", message: { role: "assistant", content: text }, done: true }; }
function recorder(handler) {
  var calls = [];
  var f = function (url, init) { calls.push({ url: url, init: init, body: init && init.body ? JSON.parse(init.body) : null }); return handler(url, init, calls.length); };
  f.calls = calls;
  return f;
}

section("Chat: request building (pure)");
test("OpenRouter request: chat completions URL, POST, Bearer header from the given key, {model, messages}", function () {
  var r = S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false);
  assert.ok(r.ok);
  assert.strictEqual(r.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.strictEqual(r.init.method, "POST");
  assert.strictEqual(r.init.headers.Authorization, "Bearer " + DUMMY_KEY);
  assert.strictEqual(r.init.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(JSON.parse(r.init.body), { model: VENICE, messages: MSGS });
});
test("the key is trimmed and only extra message fields are dropped", function () {
  var r = S.buildChatRequest("openrouter", VENICE, [{ role: "user", content: "Hi", label: "You", error: "" }], "  " + DUMMY_KEY + "\n", false);
  assert.strictEqual(r.init.headers.Authorization, "Bearer " + DUMMY_KEY);
  assert.deepStrictEqual(JSON.parse(r.init.body).messages, [{ role: "user", content: "Hi" }]);
});
test("no key: OpenRouter request is refused before any network call", function () {
  ["", "   ", null, undefined].forEach(function (k) {
    var r = S.buildChatRequest("openrouter", VENICE, MSGS, k, false);
    assert.ok(!r.ok && r.code === "no-key" && /key/i.test(r.error));
  });
  assert.ok(!S.buildChatRequest("openrouter", "", MSGS, DUMMY_KEY, false).ok, "no model");
});
test("local provider uses the localhost Ollama URL with model dolphin3, stream false, and no key", function () {
  var r = S.buildChatRequest("local", VENICE, MSGS, "", false);
  assert.ok(r.ok);
  assert.strictEqual(r.url, "http://localhost:11434/api/chat");
  assert.strictEqual(S.OLLAMA_CHAT_URL, "http://localhost:11434/api/chat");
  assert.strictEqual(r.init.method, "POST");
  assert.deepStrictEqual(JSON.parse(r.init.body), { model: "dolphin3", messages: MSGS, stream: false });
  assert.ok(!("Authorization" in r.init.headers), "local mode must not send a key");
  var withKey = S.buildChatRequest("local", HERMES, MSGS, DUMMY_KEY, false);
  assert.ok(!("Authorization" in withKey.init.headers), "a saved OpenRouter key never goes to Ollama");
  assert.strictEqual(JSON.parse(withKey.init.body).model, "dolphin3");
});
test("streaming is opt-in: stream:true is sent only when asked", function () {
  assert.ok(!("stream" in JSON.parse(S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false).init.body)));
  assert.strictEqual(JSON.parse(S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, true).init.body).stream, true);
  assert.strictEqual(JSON.parse(S.buildChatRequest("local", "", MSGS, "", true).init.body).stream, true);
});
test("default chat model is Venice Uncensored, and Nous Hermes 3 70B is offered", function () {
  assert.strictEqual(S.DEFAULT_CHAT_MODEL, VENICE);
  var ids = S.FEATURED_CHAT_MODELS.map(function (m) { return m.id; });
  assert.deepStrictEqual(ids, [VENICE, HERMES]);
  assert.strictEqual(S.FEATURED_CHAT_MODELS[0].name, "Venice Uncensored");
  assert.strictEqual(S.FEATURED_CHAT_MODELS[1].name, "Nous Hermes 3 70B");
  assert.ok(new RegExp('<select id="chat-model"[^>]*>\\s*<option value="' + VENICE + '" selected>').test(pageHtml), "Venice is the default in the markup");
});
test("HTTP errors become plain-language messages", function () {
  assert.ok(/rejected the key/.test(S.httpErrorText("openrouter", 401, "")));
  assert.ok(/credits/.test(S.httpErrorText("openrouter", 402, "")));
  assert.ok(/rate limiting/.test(S.httpErrorText("openrouter", 429, "")));
  assert.ok(/ollama pull dolphin3/.test(S.httpErrorText("local", 404, "")));
  assert.ok(/HTTP 500\. OpenRouter said: boom/.test(S.httpErrorText("openrouter", 500, "boom")));
});
test("local mode check: works only from a page served over http from this computer", function () {
  ["http://localhost:8000/", "http://127.0.0.1:5500/model-scout/", "http://[::1]:8000/"].forEach(function (u) { assert.ok(S.localModeCheck(u).ok, u); });
  var pub = S.localModeCheck("https://battlettt.github.io/model-scout/");
  assert.ok(!pub.ok && /battlettt\.github\.io/.test(pub.text) && /localhost/.test(pub.text));
  assert.ok(!S.localModeCheck("file:///Users/x/model-scout/index.html").ok);
  assert.ok(!S.localModeCheck("not a url").ok);
});
test("stream lines: server-sent events, comments, [DONE], Ollama JSON lines, and errors", function () {
  assert.deepStrictEqual(S.streamDelta("openrouter", ": OPENROUTER PROCESSING"), {});
  assert.deepStrictEqual(S.streamDelta("openrouter", "data: [DONE]"), { done: true });
  assert.strictEqual(S.streamDelta("openrouter", 'data: {"choices":[{"delta":{"content":"Hi"}}]}').text, "Hi");
  assert.ok(/overloaded/.test(S.streamDelta("openrouter", 'data: {"error":{"message":"overloaded"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}').error));
  assert.deepStrictEqual(S.streamDelta("local", '{"message":{"content":"Yo"},"done":false}'), { text: "Yo", done: false });
  assert.strictEqual(S.streamDelta("local", '{"message":{"content":""},"done":true}').done, true);
  assert.ok(/missing/.test(S.streamDelta("local", '{"error":"model missing"}').error));
  assert.deepStrictEqual(S.takeLines("a\nb\r\nc"), { lines: ["a", "b"], rest: "c" });
});

section("Chat: side by side and ask this model (pure)");
test("side by side renders two labelled columns with status, answer, and error", function () {
  var left = S.sideColumnHtml("Left", { status: "done", model: VENICE, label: "Venice Uncensored", text: "Paris." });
  var right = S.sideColumnHtml("Right", { status: "error", model: HERMES, label: "Nous Hermes 3 70B", text: "", error: "OpenRouter returned HTTP 500." });
  assert.ok(/>Left</.test(left) && /class="side-name">Venice Uncensored</.test(left) && /badge ok">Done</.test(left) && /Paris\./.test(left));
  assert.ok(/>Right</.test(right) && /class="side-name">Nous Hermes 3 70B</.test(right) && /badge warn">Error</.test(right) && /verdict warn">OpenRouter returned HTTP 500/.test(right));
  assert.ok(/badge live">Sending</.test(S.sideColumnHtml("Left", { status: "sending", label: "X" })));
  assert.ok(/No model chosen/.test(S.sideColumnHtml("Right", { status: "idle" })));
  var cols = pageHtml.match(/<div id="side-cols"[^>]*>[\s\S]*?<\/article>\s*<article[\s\S]*?<\/article>\s*<\/div>/);
  assert.ok(cols, "side-cols block missing");
  assert.strictEqual((cols[0].match(/<article id="side-col-[ab]" class="side-col"/g) || []).length, 2, "exactly two columns");
  assert.ok(/aria-label="Left answer"/.test(cols[0]) && /aria-label="Right answer"/.test(cols[0]));
  assert.ok(/\.side-cols \{[^}]*grid-template-columns/.test(css) && /@media \(min-width: 40em\) \{ \.side-cols \{ grid-template-columns: repeat\(2/.test(css), "two columns from 40em");
});
test("model answers are escaped, never injected as HTML", function () {
  var h = S.sideColumnHtml("Left", { status: "done", label: "<b>x</b>", text: '<img src=x onerror="alert(1)">' });
  assert.ok(h.indexOf("<img") < 0 && h.indexOf("<b>") < 0 && /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/.test(h));
});
test("ask this model: single mode sets the chat model; side by side fills the first empty slot, else the left", function () {
  assert.deepStrictEqual(S.askTarget("single", ["a", "b"]), { target: "single" });
  assert.deepStrictEqual(S.askTarget("side", ["", ""]), { target: "slot", index: 0 });
  assert.deepStrictEqual(S.askTarget("side", ["a", ""]), { target: "slot", index: 1 });
  assert.deepStrictEqual(S.askTarget("side", ["", "b"]), { target: "slot", index: 0 });
  assert.deepStrictEqual(S.askTarget("side", ["a", "b"]), { target: "slot", index: 0 });
});
test("every model card gets an Ask this model button wired to the chat", function () {
  assert.ok(/askButton\(m\) \+\s*"<\/article>"/.test(appJs), "card template ends with the ask button");
  assert.ok(/class="btn ask-btn" data-ask="' \+ esc\(m\.openrouter_id\)/.test(appJs), "button carries the OpenRouter id");
  assert.ok(/Ask this model<span class="visually-hidden">: ' \+ esc\(m\.model\)/.test(appJs), "accessible name includes the model");
  assert.ok(/class="btn ask-btn" disabled aria-describedby=/.test(appJs), "models that cannot chat say why");
  assert.ok(/\$\("cards"\)\.addEventListener\("click"/.test(appJs) && /closest\("\.ask-btn"\)/.test(appJs), "one delegated click handler");
});

section("Chat: key box (localStorage only)");
test("save, read, and forget the key in storage under one name", function () {
  var st = fakeStorage();
  assert.strictEqual(S.readKey(st), "");
  assert.ok(S.saveKey(st, "  " + DUMMY_KEY + " ").ok);
  assert.strictEqual(st.data[S.KEY_STORAGE], DUMMY_KEY);
  assert.strictEqual(S.readKey(st), DUMMY_KEY);
  assert.ok(S.forgetKey(st));
  assert.strictEqual(S.readKey(st), "");
  assert.ok(!S.saveKey(st, "   ").ok, "empty key refused");
  assert.ok(!S.saveKey(st, "two words").ok, "key with spaces refused");
});
test("blocked storage never throws and explains itself", function () {
  var b = blockedStorage();
  assert.strictEqual(S.readKey(b), "");
  assert.strictEqual(S.readKey(null), "");
  var r = S.saveKey(b, DUMMY_KEY);
  assert.ok(!r.ok && /local storage/.test(r.error));
  assert.strictEqual(S.forgetKey(b), false);
});
test("the key is stored with localStorage only: no cookies, sessionStorage, or IndexedDB", function () {
  assert.ok(/window\.localStorage/.test(appJs));
  assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(appJs));
  assert.strictEqual((appJs.match(/"Bearer " \+/g) || []).length, 1, "one place builds the Authorization header");
  assert.ok(/"Authorization": "Bearer " \+ k \}/.test(appJs), "header value comes from the stored key variable");
});
test("no hard-coded API key or Bearer token in any file in the repo", function () {
  var patterns = [
    /sk-or-v1-[0-9a-f]{16,}/i, /\bsk-[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/,
    /Bearer\s+[A-Za-z0-9._~+\/-]{12,}/, /["']?Authorization["']?\s*:\s*["']Bearer [^"' ]/
  ];
  var files = [];
  (function walk(dir) {
    fs.readdirSync(dir).forEach(function (n) {
      if (n === ".git" || n === "node_modules") return;
      var f = path.join(dir, n), st = fs.lstatSync(f);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) walk(f); else files.push(f);
    });
  })(ROOT);
  assert.ok(files.length >= 8, "walked " + files.length + " files");
  files.forEach(function (f) {
    var text = fs.readFileSync(f, "utf8");
    patterns.forEach(function (re) { assert.ok(!re.test(text), path.relative(ROOT, f) + " matches " + re); });
  });
  assert.ok(!/value="[^"]+"[^>]*id="chat-key"|id="chat-key"[^>]*value="[^"]+"/.test(pageHtml), "key field ships empty");
});
test("the UI warns that the key lives in this browser only", function () {
  assert.ok(/<input id="chat-key" type="password" autocomplete="off"/.test(pageHtml), "key field is a password field without autocomplete");
  var warn = pageHtml.match(/<p id="chat-key-warning"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(warn && /this browser only/.test(warn[1]) && /local storage/.test(warn[1]) && /Authorization header/.test(warn[1]));
  assert.ok(/aria-describedby="chat-key-warning chat-key-status chat-key-error"/.test(pageHtml), "warning is tied to the field");
  assert.ok(/function promptForKey\(\)/.test(appJs) && /if \(!key\) \{ promptForKey\(\); return; \}/.test(appJs), "sending without a key prompts for one");
});

section("Chat: page structure and style");
var CHAT_IDS = [
  "chat", "chat-h", "chat-provider-openrouter", "chat-provider-local", "chat-key-box", "chat-key-form", "chat-key", "chat-key-warning",
  "chat-key-status", "chat-key-error", "chat-key-save", "chat-key-forget", "chat-local-note", "chat-local-check", "chat-stream",
  "chat-mode-single", "chat-mode-side", "chat-main", "chat-status", "chat-single", "chat-model", "chat-model-note", "chat-log", "chat-form",
  "chat-input", "chat-send", "chat-clear", "chat-side", "side-form", "side-model-a", "side-model-b", "side-input", "side-send",
  "side-cols", "side-col-a", "side-col-b"
];
test("chat panel, key box, both pickers, and side-by-side columns exist with their IDs exactly once", function () {
  var ids = htmlIds();
  CHAT_IDS.forEach(function (id) { assert.strictEqual(ids[id], 1, "#" + id + " found " + (ids[id] || 0) + " times"); });
  assert.ok(/<a href="#chat"><span class="nav-num">3<\/span> Ask a model<\/a>/.test(pageHtml), "nav link");
});
test("provider and mode toggles are labelled radio groups, local mode explains the localhost limit", function () {
  assert.ok(/<legend>Provider<\/legend>[\s\S]*?name="chat-provider" id="chat-provider-openrouter" value="openrouter" checked[\s\S]*?name="chat-provider" id="chat-provider-local"/.test(pageHtml));
  assert.ok(/<legend>Mode<\/legend>[\s\S]*?id="chat-mode-single" value="single" checked[\s\S]*?id="chat-mode-side"/.test(pageHtml));
  var note = pageHtml.match(/<div id="chat-local-note"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.ok(/dolphin3/.test(note) && /served from localhost/.test(note) && /public https site cannot call http:\/\/localhost/.test(note) && /ollama pull dolphin3/.test(note));
  assert.ok(/The Ask a model panel is the only part that calls a model/.test(pageHtml), "about section says what is sent where");
});
test("one teal accent: Send buttons are primary, every other chat button is not", function () {
  assert.ok(/id="chat-send" class="btn primary"/.test(pageHtml) && /id="side-send" class="btn primary"/.test(pageHtml));
  ["chat-key-save", "chat-key-forget", "chat-clear"].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '" class="btn"').test(pageHtml), id + " should be a plain button");
  });
  assert.ok(!/class="btn primary ask-btn|class="btn ask-btn primary/.test(appJs), "ask buttons stay plain");
  var block = css.slice(css.indexOf("/* ---------- ask a model"), css.indexOf("footer.site {"));
  assert.ok(block.length > 500, "chat CSS block found");
  assert.ok(!/background: var\(--accent\)/.test(block), "no teal fills in the chat CSS");
});
test("chat controls: 44px targets, visible focus on the segmented labels", function () {
  [/\.seg label \{[^}]*min-height: 44px/, /\.key-box input\[type="password"\] \{[^}]*min-height: 44px/].forEach(function (re) {
    assert.ok(re.test(css), "missing 44px target: " + re);
  });
  assert.ok(/\.seg input:focus-visible \+ label \{[^}]*outline: 3px solid var\(--focus\)/.test(css), "segmented focus ring");
  assert.ok(/\.key-box input\[type="password"\]:focus-visible \{[^}]*outline: 3px solid var\(--focus\)/.test(css), "key field focus ring");
  assert.ok(/<div id="chat-log"[^>]*role="log"[^>]*aria-live="polite"[^>]*tabindex="0"/.test(pageHtml), "scrollable log is focusable and announced");
});
test("no broken or absolute asset paths in markup that app.js builds", function () {
  assert.ok(!/(?:src|href)="\//.test(appJs), "absolute path in generated markup");
  assert.ok(!/fetch\("\//.test(appJs), "absolute fetch path");
  assert.ok(!/<(?:img|script|link)\b/.test(appJs.replace(/&lt;img/g, "")), "app.js loads no extra assets");
});
test("AGENTS.md is a symlink to CLAUDE.md, and CLAUDE.md stays under 60 lines", function () {
  var a = path.join(ROOT, "AGENTS.md");
  assert.ok(fs.lstatSync(a).isSymbolicLink(), "AGENTS.md must be a symlink");
  assert.strictEqual(fs.readlinkSync(a), "CLAUDE.md");
  assert.ok(fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8").trim().split("\n").length < 60);
});

// ------------------------------------------------------------------
// Async engine tests: stubbed fetch only. Run in order after the sync tests.
var asyncQueue = [];
function asection(name) { asyncQueue.push({ section: name }); }
function atest(name, fn) { asyncQueue.push({ name: name, fn: fn }); }
function runAsync(i) {
  if (i >= asyncQueue.length) return Promise.resolve();
  var item = asyncQueue[i];
  if (item.section) { section(item.section); return runAsync(i + 1); }
  var timer;
  var limit = new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error("timed out after 3s")); }, 3000); });
  return Promise.race([Promise.resolve().then(item.fn), limit]).then(function () {
    results.pass++; console.log("  ok   " + item.name);
  }, function (e) {
    results.fail++; results.failures.push(group + " > " + item.name + ": " + e.message); console.log("  FAIL " + item.name + "\n       " + e.message);
  }).then(function () { clearTimeout(timer); return runAsync(i + 1); });
}

asection("Chat: sending (stubbed fetch, no network)");
atest("OpenRouter answer is read from choices[0].message.content", function () {
  var f = recorder(function () { return Promise.resolve(jsonRes(orAnswer("Paris."))); });
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false)).then(function (r) {
    assert.deepStrictEqual([r.ok, r.text], [true, "Paris."]);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, S.OPENROUTER_CHAT_URL);
    assert.strictEqual(f.calls[0].init.headers.Authorization, "Bearer " + DUMMY_KEY);
    assert.ok(f.calls[0].init.signal, "request can be stopped by the timeout");
  });
});
atest("local answer is read from message.content, sent to localhost with dolphin3 and stream false", function () {
  var f = recorder(function () { return Promise.resolve(jsonRes(ollamaAnswer("Hi from Ollama"))); });
  return S.sendChat(f, S.buildChatRequest("local", "", MSGS, "", false)).then(function (r) {
    assert.ok(r.ok && r.text === "Hi from Ollama");
    assert.strictEqual(f.calls[0].url, "http://localhost:11434/api/chat");
    assert.deepStrictEqual(f.calls[0].body, { model: "dolphin3", messages: MSGS, stream: false });
  });
});
atest("without a key, fetch is never called", function () {
  var f = recorder(function () { throw new Error("must not be called"); });
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, "", false)).then(function (r) {
    assert.ok(!r.ok && /key/i.test(r.error));
    assert.strictEqual(f.calls.length, 0);
  });
});
atest("HTTP 401 explains the key problem and quotes OpenRouter's message", function () {
  var f = recorder(function () { return Promise.resolve(jsonRes({ error: { message: "No auth credentials found", code: 401 } }, 401)); });
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false)).then(function (r) {
    assert.ok(!r.ok && r.status === 401 && /rejected the key/.test(r.error) && /No auth credentials found/.test(r.error));
  });
});
atest("network failure never rejects; local mode names localhost and where the page is served from", function () {
  var f = recorder(function () { return Promise.reject(new TypeError("Failed to fetch")); });
  return S.sendChat(f, S.buildChatRequest("local", "", MSGS, "", false), { pageUrl: "https://battlettt.github.io/model-scout/" }).then(function (r) {
    assert.ok(!r.ok && /Could not reach Ollama on localhost port 11434/.test(r.error) && /battlettt\.github\.io/.test(r.error));
    return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false));
  }).then(function (r) { assert.ok(!r.ok && /Could not reach OpenRouter/.test(r.error)); });
});
atest("a fetch that throws synchronously is handled like a network failure", function () {
  var f = function () { throw new TypeError("blocked by policy"); };
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false)).then(function (r) {
    assert.ok(!r.ok && /blocked by policy/.test(r.error));
  });
});
atest("unreadable, error-bearing, or empty 200 responses are errors, not blank answers", function () {
  var cases = [
    [badJsonRes(), /not valid JSON/], [jsonRes({ nothing: true }), /did not contain an answer/],
    [jsonRes(orAnswer("   ")), /empty answer/], [jsonRes({ error: { message: "Provider returned error" } }), /reported an error: Provider returned error/]
  ];
  return cases.reduce(function (p, c) {
    return p.then(function () {
      return S.sendChat(function () { return Promise.resolve(c[0]); }, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false)).then(function (r) {
        assert.ok(!r.ok && c[1].test(r.error), r.error);
      });
    });
  }, Promise.resolve());
});
atest("timeout: a request with no answer is stopped with a clear message", function () {
  var f = function (url, init) {
    return new Promise(function (_, rej) {
      init.signal.addEventListener("abort", function () { var e = new Error("aborted"); e.name = "AbortError"; rej(e); });
    });
  };
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false), { timeoutMs: 30 }).then(function (r) {
    assert.ok(!r.ok && /request was stopped/.test(r.error));
  });
});
atest("streaming: OpenRouter events split across chunks render token by token", function () {
  var chunks = [": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"lo"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'];
  var seen = [];
  return S.sendChat(function () { return Promise.resolve(streamRes(chunks)); }, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, true), {
    onDelta: function (t) { seen.push(t); }
  }).then(function (r) {
    assert.ok(r.ok && r.text === "Hello world", JSON.stringify(r));
    assert.deepStrictEqual(seen, ["Hel", "Hello", "Hello world"]);
  });
});
atest("streaming: Ollama JSON lines, and a final line without a newline", function () {
  var chunks = ['{"message":{"content":"Lo"},"done":false}\n{"message":{"content":"cal"},', '"done":false}\n{"message":{"content":"!"},"done":true}'];
  return S.sendChat(function () { return Promise.resolve(streamRes(chunks)); }, S.buildChatRequest("local", "", MSGS, "", true)).then(function (r) {
    assert.ok(r.ok && r.text === "Local!", JSON.stringify(r));
  });
});
atest("streaming: an error mid-stream keeps the partial answer and stops reading", function () {
  var res = streamRes(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n', 'data: {"error":{"message":"upstream died"}}\n', 'data: {"choices":[{"delta":{"content":"NEVER"}}]}\n']);
  return S.sendChat(function () { return Promise.resolve(res); }, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, true)).then(function (r) {
    assert.ok(!r.ok && r.text === "Partial" && /upstream died/.test(r.error), JSON.stringify(r));
    assert.ok(res.reader.cancelled, "reader cancelled after the error");
  });
});
atest("streaming: a stream that stalls is stopped by the idle timeout and keeps the partial answer", function () {
  var enc = new TextEncoder();
  var f = function (url, init) {
    var first = true;
    return Promise.resolve({ ok: true, status: 200, body: { getReader: function () {
      return { read: function () {
        if (first) { first = false; return Promise.resolve({ done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"Half an"}}]}\n') }); }
        return new Promise(function (_, rej) { init.signal.addEventListener("abort", function () { var e = new Error("aborted"); e.name = "AbortError"; rej(e); }); });
      }, cancel: function () {} };
    } } });
  };
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, true), { timeoutMs: 30 }).then(function (r) {
    assert.ok(!r.ok && r.text === "Half an" && /request was stopped/.test(r.error), JSON.stringify(r));
  });
});
atest("streaming falls back to reading the whole body when there is no stream reader", function () {
  var body = 'data: {"choices":[{"delta":{"content":"Whole"}}]}\n\ndata: {"choices":[{"delta":{"content":" body"}}]}\n\ndata: [DONE]\n';
  return S.sendChat(function () { return Promise.resolve(textRes(body)); }, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, true)).then(function (r) {
    assert.ok(r.ok && r.text === "Whole body", JSON.stringify(r));
  });
});
atest("the non-streaming path is untouched by streaming support", function () {
  var f = recorder(function () { return Promise.resolve(jsonRes(orAnswer("plain"))); });
  return S.sendChat(f, S.buildChatRequest("openrouter", VENICE, MSGS, DUMMY_KEY, false), { onDelta: function () { throw new Error("no deltas without streaming"); } })
    .then(function (r) { assert.ok(r.ok && r.text === "plain"); assert.ok(!("stream" in f.calls[0].body)); });
});

asection("Chat: side by side (stubbed fetch)");
function sideCols(key) {
  return [
    { model: VENICE, label: "Venice Uncensored", req: S.buildChatRequest("openrouter", VENICE, MSGS, key, false) },
    { model: HERMES, label: "Nous Hermes 3 70B", req: S.buildChatRequest("openrouter", HERMES, MSGS, key, false) }
  ];
}
atest("both requests fire in parallel, before either answers", function () {
  var release = [];
  var f = recorder(function () { return new Promise(function (res) { release.push(res); }); });
  var done = S.runCompare(f, sideCols(DUMMY_KEY), null);
  assert.strictEqual(f.calls.length, 2, "both fetches started at once");
  assert.deepStrictEqual(f.calls.map(function (c) { return c.body.model; }), [VENICE, HERMES]);
  release.forEach(function (r, i) { r(jsonRes(orAnswer("answer " + i))); });
  return done.then(function (cols) { assert.deepStrictEqual(cols.map(function (c) { return c.text; }), ["answer 0", "answer 1"]); });
});
atest("one column fails (HTTP 500), the other answer is kept; statuses go sending then done or error", function () {
  var log = [];
  var f = recorder(function (url, init) {
    return JSON.parse(init.body).model === HERMES ? Promise.resolve(jsonRes({ error: { message: "upstream" } }, 500)) : Promise.resolve(jsonRes(orAnswer("Left answer")));
  });
  return S.runCompare(f, sideCols(DUMMY_KEY), function (i, st) { log.push(i + ":" + st.status); }).then(function (cols) {
    assert.strictEqual(cols[0].status, "done");
    assert.strictEqual(cols[0].text, "Left answer");
    assert.strictEqual(cols[1].status, "error");
    assert.ok(/HTTP 500/.test(cols[1].error) && /upstream/.test(cols[1].error));
    assert.deepStrictEqual(log.filter(function (s) { return s[0] === "0"; }), ["0:sending", "0:done"]);
    assert.deepStrictEqual(log.filter(function (s) { return s[0] === "1"; }), ["1:sending", "1:error"]);
    var html = S.sideColumnHtml("Left", cols[0]) + S.sideColumnHtml("Right", cols[1]);
    assert.ok(/Left answer/.test(html) && /badge ok">Done/.test(html) && /badge warn">Error/.test(html));
  });
});
atest("a network failure on the left does not block a streamed answer on the right", function () {
  var cols = sideCols(DUMMY_KEY);
  cols[1].req = S.buildChatRequest("openrouter", HERMES, MSGS, DUMMY_KEY, true);
  var f = function (url, init) {
    return JSON.parse(init.body).model === VENICE ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(streamRes(['data: {"choices":[{"delta":{"content":"Right "}}]}\n', 'data: {"choices":[{"delta":{"content":"side"}}]}\n']));
  };
  return S.runCompare(f, cols, null).then(function (res) {
    assert.ok(res[0].status === "error" && /Could not reach OpenRouter/.test(res[0].error));
    assert.ok(res[1].status === "done" && res[1].text === "Right side");
  });
});
atest("an empty slot errors on its own and the other column still runs", function () {
  var cols = sideCols(DUMMY_KEY);
  cols[0] = { model: "", label: "", req: null };
  var f = recorder(function () { return Promise.resolve(jsonRes(orAnswer("only right"))); });
  return S.runCompare(f, cols, null).then(function (res) {
    assert.ok(res[0].status === "error" && /No model chosen/.test(res[0].error));
    assert.ok(res[1].status === "done" && res[1].text === "only right");
    assert.strictEqual(f.calls.length, 1);
  });
});
atest("a render error in one column does not stop the other", function () {
  var f = function () { return Promise.resolve(jsonRes(orAnswer("fine"))); };
  var rendered = [];
  return S.runCompare(f, sideCols(DUMMY_KEY), function (i, st) { if (i === 0) throw new Error("render broke"); rendered.push(st.status); }).then(function (res) {
    assert.deepStrictEqual(res.map(function (c) { return c.status; }), ["done", "done"]);
    assert.deepStrictEqual(rendered, ["sending", "done"]);
  });
});

// ------------------------------------------------------------------
// DOM smoke tests run in a child process (they are async and need jsdom, which is optional).
function domSmoke() {
  section("DOM smoke tests (jsdom, see tests/dom_smoke.js)");
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
}

// ------------------------------------------------------------------
runAsync(0).then(function () {
  domSmoke();
  console.log("\n" + results.pass + " passed, " + results.fail + " failed, " + (results.pass + results.fail) + " total");
  if (results.fail) { console.log(results.failures.join("\n")); process.exit(1); }
  process.exit(0);
});
