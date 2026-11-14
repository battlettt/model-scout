#!/usr/bin/env node
// Copies catalog.json into the <script id="embedded-catalog"> block of index.html.
// The embedded copy is used when index.html is opened as a local file (file://),
// where browsers block fetch("catalog.json"). Run after every catalog edit.
// It also stamps styles.css and app.js in index.html with a hash of their content (?v=...), so a browser that
// cached the old files for a few minutes after a deploy still loads files that match the new page.
// Run after every edit to catalog.json, app.js, or styles.css; a test fails if either is out of date.
"use strict";
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.join(__dirname, "..");
var OPEN = '<script type="application/json" id="embedded-catalog">';

function embeddedJson(catalogText) {
  // Escaping "<" keeps "</script>" out of the block while staying valid JSON.
  return JSON.stringify(JSON.parse(catalogText)).replace(/</g, "\\u003c");
}

/** First 10 hex characters of a SHA-256 over app.js and styles.css. */
function assetVersion() {
  var h = crypto.createHash("sha256");
  ["app.js", "styles.css"].forEach(function (f) { h.update(fs.readFileSync(path.join(ROOT, f))); h.update("\n"); });
  return h.digest("hex").slice(0, 10);
}

var STYLE_RE = /<link rel="stylesheet" href="styles\.css(?:\?v=[0-9a-f]+)?">/;
var SCRIPT_RE = /<script src="app\.js(?:\?v=[0-9a-f]+)?"><\/script>/;

function stampAssets(html, v) {
  if (!STYLE_RE.test(html) || !SCRIPT_RE.test(html)) throw new Error("styles.css link or app.js script tag not found in index.html");
  return html.replace(STYLE_RE, '<link rel="stylesheet" href="styles.css?v=' + v + '">').replace(SCRIPT_RE, '<script src="app.js?v=' + v + '"></script>');
}

function sync() {
  var htmlPath = path.join(ROOT, "index.html");
  var html = fs.readFileSync(htmlPath, "utf8");
  var start = html.indexOf(OPEN);
  if (start < 0) throw new Error("embedded-catalog block not found in index.html");
  var bodyStart = start + OPEN.length;
  var end = html.indexOf("</script>", bodyStart);
  var json = embeddedJson(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
  var out = stampAssets(html.slice(0, bodyStart) + "\n" + json + "\n  " + html.slice(end), assetVersion());
  fs.writeFileSync(htmlPath, out);
  return json.length;
}

if (require.main === module) console.log("Embedded catalog updated (" + sync() + " bytes); assets stamped v=" + assetVersion() + ".");
module.exports = { OPEN: OPEN, assetVersion: assetVersion, stampAssets: stampAssets };
