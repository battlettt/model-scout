#!/usr/bin/env node
// Copies catalog.json into the <script id="embedded-catalog"> block of index.html.
// The embedded copy is used when index.html is opened as a local file (file://),
// where browsers block fetch("catalog.json"). Run after every catalog edit.
"use strict";
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var OPEN = '<script type="application/json" id="embedded-catalog">';

function embeddedJson(catalogText) {
  // Escaping "<" keeps "</script>" out of the block while staying valid JSON.
  return JSON.stringify(JSON.parse(catalogText)).replace(/</g, "\\u003c");
}

function sync() {
  var htmlPath = path.join(ROOT, "index.html");
  var html = fs.readFileSync(htmlPath, "utf8");
  var start = html.indexOf(OPEN);
  if (start < 0) throw new Error("embedded-catalog block not found in index.html");
  var bodyStart = start + OPEN.length;
  var end = html.indexOf("</script>", bodyStart);
  var json = embeddedJson(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
  var out = html.slice(0, bodyStart) + "\n" + json + "\n  " + html.slice(end);
  fs.writeFileSync(htmlPath, out);
  return json.length;
}

if (require.main === module) console.log("Embedded catalog updated (" + sync() + " bytes).");
module.exports = { OPEN: OPEN };
