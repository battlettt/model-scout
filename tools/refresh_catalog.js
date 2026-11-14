#!/usr/bin/env node
// Refresh catalog.json from a saved copy of OpenRouter's public model list, then re-embed it in index.html.
//
//   curl -s https://openrouter.ai/api/v1/models -o /tmp/openrouter-models.json
//   node tools/refresh_catalog.js /tmp/openrouter-models.json            (writes catalog.json)
//   node tools/refresh_catalog.js /tmp/openrouter-models.json --dry-run  (only prints the changes)
//   node tools/refresh_catalog.js /tmp/openrouter-models.json --date 2026-11-13
//   curl -s https://openrouter.ai/api/v1/endpoints/zdr -o /tmp/openrouter-zdr.json
//   node tools/refresh_catalog.js /tmp/openrouter-models.json --zdr /tmp/openrouter-zdr.json
//     (also records each model's zero-data-retention endpoints: count, providers, cheapest prices)
//
// For every catalog entry with an openrouter_id that the list contains, it updates the prices, context window,
// capabilities, input types, cache and batch prices, output limit, retirement and listing dates, sets price_status to
// "verified", and stamps last_verified and the source with the snapshot date. Editorial fields (quality_tier,
// latency_class, task_fit, strengths, limits, local_hardware) are never touched. Entries the list does not
// contain are reported and left alone, so they go stale on their own dates.
"use strict";
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var S = require("../app.js");

var ROOT = path.join(__dirname, "..");
var SOURCE_NAME = "OpenRouter public models API (https://openrouter.ai/api/v1/models), snapshot ";

function today() { return new Date().toISOString().slice(0, 10); }

function args(argv) {
  var a = { file: null, dryRun: false, date: today(), zdr: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--date") a.date = argv[++i];
    else if (argv[i] === "--zdr") a.zdr = argv[++i];
    else if (!a.file) a.file = argv[i];
  }
  if (!a.file) throw new Error("Pass the path of a saved OpenRouter model list (see the comment at the top of this file).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || "")) throw new Error("--date must be YYYY-MM-DD");
  return a;
}

/** Pure: the refreshed catalog plus a list of human-readable changes. Exported for tests. */
function refresh(catalog, orData, date, zdrList) {
  var byId = {};
  (orData || []).forEach(function (m) { if (m && m.id) byId[m.id] = m; });
  var changes = [], missing = [], updated = 0;
  var out = JSON.parse(JSON.stringify(catalog));
  out.models.forEach(function (e) {
    if (!e.openrouter_id) return;
    if (zdrList) {
      var z = S.zdrFacts(e.openrouter_id, zdrList), zb = JSON.stringify(e.zdr === undefined ? null : e.zdr);
      if (zb !== JSON.stringify(z)) changes.push(e.id + ": zdr " + (e.zdr ? e.zdr.endpoints : "none") + " -> " + z.endpoints + (z.endpoints === 1 ? " endpoint" : " endpoints") +
        (z.endpoints ? ", cheapest " + z.cheapest + " $" + z.input_price_per_mtok + " / $" + z.output_price_per_mtok : ""));
      e.zdr = z;
    }
    var live = byId[e.openrouter_id];
    if (!live || !live.pricing) { missing.push(e.id); return; }
    var pin = S.perMillion(live.pricing.prompt), pout = S.perMillion(live.pricing.completion);
    if (pin === null || pout === null || pin < 0 || pout < 0) { missing.push(e.id); return; }
    var next = { input_price_per_mtok: pin, output_price_per_mtok: pout };
    if (typeof live.context_length === "number" && live.context_length > 0) next.context_window = live.context_length;
    var facts = S.liveFacts(live, byId);
    Object.keys(facts).forEach(function (k) { next[k] = facts[k]; });
    var diffs = [];
    Object.keys(next).forEach(function (k) {
      var before = JSON.stringify(e[k] === undefined ? null : e[k]), after = JSON.stringify(next[k]);
      if (before !== after) diffs.push(k + " " + before + " -> " + after);
      e[k] = next[k];
    });
    e.price_status = "verified";
    e.last_verified = date;
    e.source = { name: SOURCE_NAME + date, url: "https://openrouter.ai/" + e.openrouter_id };
    updated++;
    if (diffs.length) changes.push(e.id + ": " + diffs.join("; "));
  });
  out.catalog_date = date;
  if (zdrList) out.zdr_snapshot = date;
  return { catalog: out, updated: updated, changes: changes, missing: missing };
}

function main() {
  var a = args(process.argv.slice(2));
  var list = JSON.parse(fs.readFileSync(a.file, "utf8"));
  if (!list || !Array.isArray(list.data)) throw new Error("That file is not an OpenRouter model list (no data array).");
  var catalogPath = path.join(ROOT, "catalog.json");
  var zdr = null;
  if (a.zdr) {
    zdr = JSON.parse(fs.readFileSync(a.zdr, "utf8"));
    if (!zdr || !Array.isArray(zdr.data)) throw new Error("That --zdr file is not OpenRouter's ZDR endpoint list (no data array).");
  }
  var r = refresh(JSON.parse(fs.readFileSync(catalogPath, "utf8")), list.data, a.date, zdr && zdr.data);
  var bad = [];
  r.catalog.models.forEach(function (e) { var errs = S.validateEntry(e); if (errs.length) bad.push(e.id + ": " + errs.join("; ")); });
  console.log("Snapshot " + a.date + ": " + r.updated + " entries refreshed from " + list.data.length + " listed models.");
  console.log(r.changes.length ? "Changes:\n  " + r.changes.join("\n  ") : "No figures changed.");
  if (r.missing.length) console.log("Not in the list (left alone, will go stale): " + r.missing.join(", "));
  if (bad.length) { console.error("Validation failed, nothing written:\n  " + bad.join("\n  ")); process.exit(1); }
  if (a.dryRun) { console.log("Dry run: nothing written."); return; }
  fs.writeFileSync(catalogPath, JSON.stringify(r.catalog, null, 2) + "\n");
  childProcess.execFileSync(process.execPath, [path.join(ROOT, "tests", "sync_embedded_catalog.js")], { stdio: "inherit" });
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { refresh: refresh };
