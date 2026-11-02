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
console.log("\n" + results.pass + " passed, " + results.fail + " failed, " + (results.pass + results.fail) + " total");
if (results.fail) { console.log(results.failures.join("\n")); process.exit(1); }
