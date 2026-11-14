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
var CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
var OLLAMA_URL = "http://localhost:11434/api/chat";
var KEY_NAME = "model-scout.openrouter-key";
var DUMMY_KEY = ["dom", "test", "dummy", "value"].join("-"); // built at runtime, not a real key
var VENICE = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
var HERMES = "nousresearch/hermes-3-llama-3.1-70b";
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
  var w = dom.window, calls = [], chats = [];
  if (typeof w.TextDecoder !== "function") w.TextDecoder = require("util").TextDecoder;
  if (opts.key) w.localStorage.setItem(KEY_NAME, opts.key);
  w.fetch = function (url, init) {
    calls.push(String(url));
    if (String(url) === OR_URL) return opts.openrouter ? opts.openrouter() : Promise.reject(new TypeError("Failed to fetch"));
    if (String(url) === "catalog.json") return opts.catalog ? opts.catalog() : resp(CATALOG);
    if (String(url) === CHAT_URL || String(url) === OLLAMA_URL) {
      var c = { url: String(url), init: init, body: JSON.parse(init.body) };
      chats.push(c);
      return opts.chat ? opts.chat(c) : Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.reject(new Error("unexpected fetch " + url));
  };
  w.eval(APP);
  return { w: w, d: w.document, calls: calls, chats: chats, $: function (id) { return w.document.getElementById(id); } };
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

function orReply(text) { return resp({ choices: [{ message: { role: "assistant", content: text } }] }); }
function typeAndSend(p, inputId, buttonId, text) { p.$(inputId).value = text; p.$(buttonId).click(); }
function pick(p, id, value) { p.$(id).value = value; fire(p, id, "change"); }
function check(p, id) { p.$(id).checked = true; fire(p, id, "change"); }

test("chat: no key prompts for one; the saved key lives only in localStorage and the Bearer header", function () {
  var p = boot({ chat: function (c) { return orReply(c.body.messages.length > 1 ? "Second answer" : "Bonjour <b>!</b>"); } });
  return settled(p).then(function () {
    ok(p.$("chat-model").value === VENICE, "default model is Venice: " + p.$("chat-model").value);
    ok(/No key saved yet/.test(p.$("chat-key-status").textContent), "key status");
    typeAndSend(p, "chat-input", "chat-send", "Hello");
    ok(p.chats.length === 0, "sent without a key");
    ok(/Add your OpenRouter key/.test(p.$("chat-key-error").textContent), "no prompt for a key");
    ok(p.d.activeElement === p.$("chat-key"), "focus not moved to the key box");
    ok(p.$("chat-key").getAttribute("aria-invalid") === "true", "key field not marked");
    p.$("chat-key").value = DUMMY_KEY; p.$("chat-key-save").click();
    ok(p.w.localStorage.getItem(KEY_NAME) === DUMMY_KEY, "key not in localStorage");
    ok(p.$("chat-key").value === "" && p.d.documentElement.outerHTML.indexOf(DUMMY_KEY) < 0, "full key left in the page");
    ok(new RegExp("ending in " + DUMMY_KEY.slice(-4)).test(p.$("chat-key-status").textContent), "masked status");
    ok(!p.$("chat-key-forget").disabled, "forget disabled with a key saved");
    p.$("chat-send").click();
    ok(p.chats.length === 1, "message not sent after the key was saved");
    var c = p.chats[0];
    ok(c.url === CHAT_URL && c.init.method === "POST", "wrong endpoint");
    ok(c.init.headers.Authorization === "Bearer " + DUMMY_KEY, "Bearer header");
    ok(c.body.model === VENICE && JSON.stringify(c.body.messages) === JSON.stringify([{ role: "user", content: "Hello" }]), "body " + JSON.stringify(c.body));
    ok(p.$("chat-send").disabled && p.$("chat-log").getAttribute("aria-busy") === "true", "busy state while sending");
    return waitFor(function () { return /Bonjour/.test(p.$("chat-log").textContent); }, "answer in the log").then(function () {
      ok(!p.$("chat-log").querySelector("b"), "answer HTML was injected");
      ok(/Venice Uncensored/.test(p.$("chat-log").textContent), "answer not labelled with the model");
      ok(!p.$("chat-send").disabled, "send stays disabled");
      typeAndSend(p, "chat-input", "chat-send", "And again");
      return waitFor(function () { return /Second answer/.test(p.$("chat-log").textContent); }, "second answer");
    }).then(function () {
      ok(p.chats[1].body.messages.map(function (m) { return m.role; }).join(",") === "user,assistant,user", "history not sent");
      p.$("chat-key-forget").click();
      ok(p.w.localStorage.getItem(KEY_NAME) === null && /No key saved/.test(p.$("chat-key-status").textContent), "forget key");
    });
  });
});

test("side by side: two labelled columns, and one failing column does not block the other", function () {
  var p = boot({ key: DUMMY_KEY, chat: function (c) {
    if (c.body.model === HERMES) return Promise.reject(new TypeError("Failed to fetch"));
    return new Promise(function (r) { setTimeout(function () { r({ ok: true, status: 200, json: function () { return Promise.resolve({ choices: [{ message: { content: "Left wins" } }] }); } }); }, 20); });
  } });
  return settled(p).then(function () {
    check(p, "chat-mode-side");
    ok(p.$("chat-single").hidden && !p.$("chat-side").hidden, "mode switch");
    ok(p.$("side-model-a").value === "" && p.$("side-model-b").value === "", "slots should start empty");
    pick(p, "side-model-a", VENICE); pick(p, "side-model-b", HERMES);
    ok(/Venice Uncensored/.test(p.$("side-col-a").textContent) && /Nous Hermes 3 70B/.test(p.$("side-col-b").textContent), "columns follow the pickers");
    typeAndSend(p, "side-input", "side-send", "Capital of France?");
    ok(p.chats.length === 2, "both requests should fire at once, got " + p.chats.length);
    ok(p.$("side-send").disabled, "send-both not disabled while busy");
    return waitFor(function () {
      return p.$("side-col-a").getAttribute("data-status") !== "sending" && p.$("side-col-b").getAttribute("data-status") !== "sending";
    }, "both columns to settle").then(function () {
      var a = p.$("side-col-a"), b = p.$("side-col-b");
      ok(a.getAttribute("data-status") === "done" && /Left wins/.test(a.textContent) && /Done/.test(a.querySelector(".badge").textContent), "left: " + a.textContent);
      ok(b.getAttribute("data-status") === "error" && /Could not reach OpenRouter/.test(b.textContent) && /Error/.test(b.querySelector(".badge").textContent), "right: " + b.textContent);
      ok(/Venice Uncensored/.test(a.querySelector(".side-name").textContent) && /Nous Hermes 3 70B/.test(b.querySelector(".side-name").textContent), "column labels");
      ok(!p.$("side-send").disabled && /One column failed/.test(p.$("chat-status").textContent), "summary: " + p.$("chat-status").textContent);
      ok(p.$("side-input").value === "Capital of France?", "question should stay for a re-send");
    });
  });
});

test("ask this model: sets the chat model in single mode; fills the first empty slot, then the left, side by side", function () {
  var p = boot({});
  return settled(p).then(function () {
    var btns = p.d.querySelectorAll("#cards .ask-btn:not([disabled])");
    ok(btns.length === p.d.querySelectorAll("#cards .card").length, "one ask button per card");
    var one = btns[0], two = btns[1];
    one.click();
    ok(p.$("chat-model").value === one.getAttribute("data-ask"), "chat model not set");
    ok(p.d.activeElement === p.$("chat-input"), "chat input not focused");
    ok(new RegExp("Chat model set to " + one.getAttribute("data-name")).test(p.$("chat-status").textContent), "status");
    check(p, "chat-mode-side");
    one.click();
    ok(p.$("side-model-a").value === one.getAttribute("data-ask") && p.$("side-model-b").value === "", "first click fills the left slot");
    two.click();
    ok(p.$("side-model-b").value === two.getAttribute("data-ask"), "second click fills the empty right slot");
    two.click();
    ok(p.$("side-model-a").value === two.getAttribute("data-ask") && p.$("side-model-b").value === two.getAttribute("data-ask"), "both filled: left is replaced");
    ok(p.d.activeElement === p.$("side-input"), "side input not focused");
    check(p, "chat-provider-local");
    one.click();
    ok(p.$("chat-provider-openrouter").checked && /Switched the provider to OpenRouter/.test(p.$("chat-status").textContent), "local mode not switched back");
    p.$("task-type").value = "embeddings"; fire(p, "task-type", "change");
    var off = p.d.querySelectorAll("#cards .ask-btn[disabled]");
    ok(off.length === p.d.querySelectorAll("#cards .card").length && /cannot chat/.test(p.$("cards").textContent), "embedding cards should explain why they cannot chat");
  });
});

test("local provider: localhost URL, model dolphin3, no key or Authorization header, localhost explanation shown", function () {
  var p = boot({ url: "http://localhost:8000/", key: DUMMY_KEY, chat: function () { return resp({ message: { role: "assistant", content: "Hi from dolphin3" }, done: true }); } });
  return settled(p).then(function () {
    check(p, "chat-provider-local");
    ok(p.$("chat-key-box").hidden && !p.$("chat-local-note").hidden, "key box should hide, local note show");
    ok(p.$("chat-model").disabled && /always uses dolphin3/.test(p.$("chat-model-note").textContent), "picker note");
    ok(/served from localhost:8000/.test(p.$("chat-local-check").textContent) && p.$("chat-local-check").classList.contains("ok"), "local check");
    ok(/public https site cannot call http:\/\/localhost/.test(p.$("chat-local-note").textContent), "https explanation");
    typeAndSend(p, "chat-input", "chat-send", "Hi");
    var c = p.chats[0];
    ok(c && c.url === OLLAMA_URL, "not sent to Ollama");
    ok(c.body.model === "dolphin3" && c.body.stream === false, "body " + JSON.stringify(c.body));
    ok(!c.init.headers.Authorization, "key leaked to Ollama");
    return waitFor(function () { return /Hi from dolphin3/.test(p.$("chat-log").textContent); }, "local answer").then(function () {
      ok(/dolphin3 \(local Ollama\)/.test(p.$("chat-log").textContent), "local answer label");
      var pub = boot({ url: "https://battlettt.github.io/model-scout/" });
      return settled(pub).then(function () {
        check(pub, "chat-provider-local");
        ok(/battlettt\.github\.io/.test(pub.$("chat-local-check").textContent) && pub.$("chat-local-check").classList.contains("warn"), "public site warning");
      });
    });
  });
});

test("streaming: tokens render as they arrive, then the answer is final", function () {
  var enc = new (require("util").TextEncoder)(), steps = [], gate;
  var chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo there"}}]}\n\ndata: [DONE]\n\n'];
  var p = boot({ key: DUMMY_KEY, chat: function () {
    var i = 0;
    return resp(null).then(function (r) {
      r.body = { getReader: function () { return { read: function () {
        if (i === 1) return new Promise(function (res) { gate = function () { res({ done: false, value: enc.encode(chunks[i++]) }); }; });
        return Promise.resolve(i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true });
      }, cancel: function () {} }; } };
      return r;
    });
  } });
  return settled(p).then(function () {
    p.$("chat-stream").checked = true;
    typeAndSend(p, "chat-input", "chat-send", "Hi");
    ok(p.chats[0].body.stream === true, "stream flag not sent");
    return waitFor(function () { return gate && /Hel/.test(p.$("chat-log").textContent); }, "first token");
  }).then(function () {
    ok(!/lo there/.test(p.$("chat-log").textContent) && p.$("chat-send").disabled, "should be mid-stream");
    gate();
    return waitFor(function () { return /Hello there/.test(p.$("chat-log").textContent) && !p.$("chat-send").disabled; }, "full streamed answer");
  });
});

test("presets: one click fills every field, marks the button, and puts the settings in the address", function () {
  var p = boot({});
  return settled(p).then(function () {
    var btns = p.d.querySelectorAll("#preset-list .preset");
    ok(btns.length === 7 && !p.$("presets").hidden, "preset buttons: " + btns.length);
    p.d.querySelector('[data-preset="bulk"]').click();
    ok(p.$("quality").value === "basic" && p.$("latency").value === "any" && p.$("budget").value === "0.5", "fields not set");
    ok(p.$("use-batch").checked && p.$("need-json").checked && !p.$("need-tools").checked, "checkboxes not set");
    ok(/Tag a million product reviews/.test(p.$("task-desc").value), "description not set");
    ok(p.d.querySelector('[data-preset="bulk"]').getAttribute("aria-pressed") === "true", "not pressed");
    ok(/batch=1/.test(p.w.location.search) && /json=1/.test(p.w.location.search) && !/Tag/.test(p.w.location.search), "address: " + p.w.location.search);
    p.$("quality").value = "good"; fire(p, "quality", "input");
    ok(p.d.querySelector('[data-preset="bulk"]').getAttribute("aria-pressed") === "false", "editing a field should release the preset");
  });
});

test("shared link: settings in the address load into the form, and bad ones are named", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=code&tools=1&cache=50&in=12&zzz=1&context=5" });
  return settled(p).then(function () {
    ok(p.$("task-type").value === "code" && p.$("need-tools").checked && p.$("cache-share").value === "0.5" && p.$("vol-in").value === "12", "settings not applied");
    ok(p.$("context-need").value === "32000", "invalid context should be skipped");
    ok(/could not read/.test(p.$("share-status").textContent) && /zzz/.test(p.$("share-status").textContent) && /context/.test(p.$("share-status").textContent), "skipped settings not named: " + p.$("share-status").textContent);
    ok(/with 50% of input cached/.test(p.$("top-pick").textContent), "cost basis missing from the headline");
  });
});

test("model cards: the top 6 show, the rest open on request or from a table link", function () {
  var p = boot({});
  return settled(p).then(function () {
    var cards = p.d.querySelectorAll("#cards .card"), shown = p.d.querySelectorAll("#cards .card:not([hidden])");
    ok(cards.length > 6 && shown.length === 6, "shown " + shown.length + " of " + cards.length);
    var btn = p.$("cards-toggle");
    ok(!btn.hidden && btn.getAttribute("aria-expanded") === "false" && /Show all/.test(btn.textContent), "toggle state");
    btn.click();
    ok(p.d.querySelectorAll("#cards .card:not([hidden])").length === cards.length && btn.getAttribute("aria-expanded") === "true", "toggle did not open all");
    btn.click();
    var last = p.d.querySelectorAll("#compare-body tr th a");
    last = last[last.length - 1];
    last.click();
    ok(!p.d.getElementById(last.getAttribute("href").slice(1)).hidden, "table link to a folded card left it hidden");
  });
});

test("confidence and capabilities: verdict under the top pick; a required capability excludes models without it", function () {
  var p = boot({});
  return settled(p).then(function () {
    var conf = p.$("top-pick").querySelector(".confidence");
    ok(conf && /Stable pick|Likely pick|Close call|Tie/.test(conf.textContent) && /of 300 reruns|on every factor/.test(conf.textContent), "confidence block: " + (conf && conf.textContent));
    var before = p.d.querySelectorAll("#compare-body tr").length;
    p.$("need-reasoning").checked = true; fire(p, "need-reasoning", "change");
    ok(p.d.querySelectorAll("#compare-body tr").length < before, "requiring reasoning mode excluded nothing");
    ok(/Does not support reasoning mode/.test(p.$("excluded").textContent), "exclusion reason missing");
    ok(/Supports tool calling/.test(p.$("cards").textContent), "card capability line missing");
  });
});

test("volume helper: requests per day fill the monthly volume fields", function () {
  var p = boot({});
  return settled(p).then(function () {
    ok(p.$("req-apply").disabled, "apply should wait for numbers");
    p.$("req-day").value = "1000"; fire(p, "req-day");
    p.$("req-in").value = "2000"; fire(p, "req-in");
    p.$("req-out").value = "500"; fire(p, "req-out");
    ok(!p.$("req-apply").disabled && /60\.83 million input/.test(p.$("req-readout").textContent), "readout: " + p.$("req-readout").textContent);
    ok(p.$("vol-in").value === "50", "fields changed before Use was pressed");
    p.$("req-apply").click();
    ok(p.$("vol-in").value === "60.83" && p.$("vol-out").value === "15.21", "fields: " + p.$("vol-in").value + " / " + p.$("vol-out").value);
  });
});

test("sample counter: pasted text fills tokens per request and the cache share, and never reaches the share link", function () {
  var p = boot({});
  return settled(p).then(function () {
    ok(p.$("sample-apply").disabled, "apply should wait for text");
    var before = p.$("cards").innerHTML;
    p.$("sample-fixed").value = "Policy text. ".repeat(500); fire(p, "sample-fixed");
    p.$("sample-var").value = "Where is my order 4411?"; fire(p, "sample-var");
    p.$("sample-reply").value = "It shipped on Monday and should arrive Thursday."; fire(p, "sample-reply");
    ok(p.$("cards").innerHTML === before, "typing a sample re-ranked the models");
    ok(!p.$("sample-apply").disabled && /cache share will be set to 90%/.test(p.$("sample-readout").textContent), "readout: " + p.$("sample-readout").textContent);
    p.$("sample-apply").click();
    ok(p.$("req-in").value === "1631" && p.$("req-out").value === "12", "request fields: " + p.$("req-in").value + " / " + p.$("req-out").value);
    ok(p.$("cache-share").value === "0.9", "cache share: " + p.$("cache-share").value);
    ok(/cache share is now 90%/.test(p.$("sample-readout").textContent) && !/will be set/.test(p.$("sample-readout").textContent), "apply message: " + p.$("sample-readout").textContent);
    ok(p.d.activeElement === p.$("req-day"), "focus should move to requests per day");
    ok(/cache=90(&|$)/.test(p.w.location.search) && !/Policy|order|shipped/i.test(p.w.location.search), "address: " + p.w.location.search);
  });
});

test("value map: one dot per ranked model; hover names it; selecting a folded model opens its card", function () {
  var p = boot({});
  return settled(p).then(function () {
    var dots = p.d.querySelectorAll("#value-map circle[data-id]");
    ok(dots.length === p.d.querySelectorAll("#compare-body tr").length, "dots " + dots.length);
    ok(p.d.querySelector("#value-map svg[role=img] title") && /sit on the frontier/.test(p.$("value-map-readout").textContent), "map not labelled");
    var lastRow = p.d.querySelectorAll("#compare-body tr th a"), id = lastRow[lastRow.length - 1].getAttribute("href").slice(6);
    var dot = p.d.querySelector('#value-map circle[data-id="' + id + '"]');
    dot.dispatchEvent(new p.w.MouseEvent("mouseover", { bubbles: true }));
    ok(/score/.test(p.$("value-map-readout").textContent) && /a month/.test(p.$("value-map-readout").textContent), "readout: " + p.$("value-map-readout").textContent);
    ok(p.$("card-" + id).hidden, "card should start folded");
    dot.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    ok(!p.$("card-" + id).hidden, "clicking a dot left the card folded");
    p.$("vol-in").value = "0"; fire(p, "vol-in"); p.$("vol-out").value = "0"; fire(p, "vol-out");
    ok(/Set a monthly volume/.test(p.$("value-map").textContent), "zero volume should explain the empty map");
  });
});

test("compare: tray and head to head; a fourth pick drops the oldest; ask both side by side", function () {
  var p = boot({});
  return settled(p).then(function () {
    var btns = p.d.querySelectorAll("#cards .compare-btn");
    btns[0].click();
    ok(!p.$("compare-tray").hidden && p.$("h2h").hidden && /Pick one or two more/.test(p.$("compare-tray-text").textContent), "one pick: tray only");
    btns[1].click();
    ok(!p.$("h2h").hidden && p.d.querySelectorAll("#h2h-table thead th").length === 3, "two picks: table with two model columns");
    ok(p.d.querySelectorAll("#h2h-table .is-best").length > 0 && /best/.test(p.$("h2h-table").textContent), "no best marks");
    btns = p.d.querySelectorAll("#cards .compare-btn");
    btns[2].click(); btns[3].click();
    ok(p.d.querySelectorAll("#h2h-table thead th").length === 4 && /was taken out/.test(p.$("compare-tray-text").textContent), "fourth pick should drop the oldest");
    ok(p.d.querySelectorAll('#cards .compare-btn[aria-pressed="true"]').length === 3, "pressed state out of sync");
    p.d.querySelector("#h2h-table .h2h-remove").click();
    ok(p.d.querySelectorAll("#h2h-table thead th").length === 3, "remove from the table");
    p.$("h2h-ask").click();
    ok(p.$("chat-mode-side").checked && !p.$("chat-side").hidden && p.$("side-model-a").value && p.$("side-model-b").value && p.$("side-model-a").value !== p.$("side-model-b").value, "side by side not set up");
    ok(p.d.activeElement === p.$("side-input"), "focus should land on the question box");
    p.$("compare-tray-clear").click();
    ok(p.$("compare-tray").hidden && p.$("h2h").hidden && !p.d.body.classList.contains("has-tray"), "clear did not reset");
  });
});

test("decision memo: copy puts Markdown on the clipboard; cheaper option shows under the top pick", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?quality=basic&speed=any&context=8000&budget=0.5&in=400&out=20&batch=1&json=1" });
  var copied = null;
  Object.defineProperty(p.w.navigator, "clipboard", { value: { writeText: function (t) { copied = t; return Promise.resolve(); } }, configurable: true });
  return settled(p).then(function () {
    ok(p.$("top-pick").querySelector(".alt-pick") && /Cheaper option within 5 points/.test(p.$("top-pick").textContent), "cheaper option missing");
    p.$("task-desc").value = "Tag product reviews";
    p.$("memo-copy").click();
    return waitFor(function () { return copied; }, "clipboard write");
  }).then(function () {
    ok(/^# Model choice: Tag product reviews/.test(copied) && /## Shortlist/.test(copied) && /Settings: http:\/\/localhost:8000\/model-scout\/index\.html\?/.test(copied), "memo text: " + copied.slice(0, 200));
    ok(/Decision memo copied/.test(p.$("share-status").textContent), "status: " + p.$("share-status").textContent);
  });
});

test("tipping points and hand-set weights: try a tip, drag a slider, go back to profile weights", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&speed=fast&budget=1&in=300&out=30&cache=50" });
  var first;
  return settled(p).then(function () {
    first = p.d.querySelector("#top-pick h3").firstChild.textContent.trim();
    var tries = p.d.querySelectorAll("#tips .tip-try");
    ok(tries.length >= 1 && tries.length <= 4, "tip rows: " + tries.length);
    ok(/comes first/.test(p.$("tips").textContent) && p.d.querySelector("#tips .tip.is-nearest"), "nearest tip missing");
    ok(p.$("weights-reset").hidden && p.$("weights-edit").getAttribute("aria-pressed") === "false", "starts on profile weights");
    var named = tries[0].closest(".tip").querySelector(".tip-who a").textContent;
    tries[0].click();
    var now = p.d.querySelector("#top-pick h3").firstChild.textContent.trim();
    ok(now === named && now !== first, "try it should put " + named + " first, got " + now);
    ok(/[?&]w=\d/.test(p.w.location.search), "weights not in the address: " + p.w.location.search);
    ok(p.d.querySelectorAll('#weights input[type="range"]').length === 5 && !p.$("weights-reset").hidden, "sliders and reset should show");
    ok(/set by hand/i.test(p.$("weights-h").textContent) && /now comes first/.test(p.$("tips-status").textContent), "heading or status not updated");
    var slider = p.d.querySelector('#weights input[data-factor="privacy"]');
    slider.value = "100";
    slider.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    ok(p.d.querySelector('#weights input[data-factor="privacy"]') === slider, "a dragged slider must not be rebuilt");
    ok(/privacy/.test(p.$("weights").textContent) && /-100(&|$)/.test(p.w.location.search), "slider value not used: " + p.w.location.search);
    p.$("weights-reset").click();
    ok(p.d.querySelector("#top-pick h3").firstChild.textContent.trim() === first, "reset should restore the original pick");
    ok(!/[?&]w=/.test(p.w.location.search) && p.$("weights-reset").hidden && !p.d.querySelector('#weights input'), "reset should clear the weights");
  });
});

test("market watch: new models, price moves, and retirements from the live list, checked against the profile", function () {
  var sample = orSample(), first = CATALOG.models.filter(function (m) { return m.openrouter_id; })[0];
  sample.data[1].created = Math.floor(Date.now() / 1000) - 3 * 86400;
  sample.data[1].expiration_date = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  var p = boot({ openrouter: function () { return resp(sample); } });
  return settled(p).then(function () {
    ok(/From OpenRouter's public model list, fetched/.test(p.$("market-source").textContent), "source: " + p.$("market-source").textContent);
    var fresh = p.$("mw-fresh").textContent;
    ok(/Live Only One/.test(fresh) && /Listed 3 days ago/.test(fresh), "new list: " + fresh.slice(0, 200));
    ok(/Fits your hard limits|Ruled out for you/.test(fresh), "fresh row should be checked against the profile");
    ok(!p.$("mw-fresh-note").hidden && /^1 of these is not reviewed/.test(p.$("mw-fresh-note-text").textContent), "note: " + p.$("mw-fresh-note-text").textContent);
    var moves = p.$("mw-moves").textContent;
    ok(moves.indexOf(first.model) >= 0 && /down (49\.\d|50)%/.test(moves) && /At your volume/.test(moves), "moves: " + moves.slice(0, 240));
    ok(p.$("mw-moves-count").textContent === "1", "moves count: " + p.$("mw-moves-count").textContent);
    var retire = p.$("mw-retire").textContent;
    ok(/Live Only One/.test(retire) && /Retires in (9|10) days/.test(retire), "retiring: " + retire.slice(0, 200));
    ok(!p.$("include-live").checked, "live models start out of the ranking");
    p.$("mw-include").click();
    ok(p.$("include-live").checked && /Rank reviewed models only/.test(p.$("mw-include").textContent), "include button should tick the live checkbox");
    ok(/They are in the ranking now/.test(p.$("mw-fresh-note-text").textContent), "note should follow the checkbox");
  });
});

test("market watch without live data: says so, and compares no prices", function () {
  var p = boot({});
  return settled(p).then(function () {
    ok(/did not load/.test(p.$("market-source").textContent) && /bundled snapshot/.test(p.$("market-source").textContent), "source: " + p.$("market-source").textContent);
    ok(/Needs the live list/.test(p.$("mw-moves").textContent), "moves: " + p.$("mw-moves").textContent);
    ok(p.$("mw-fresh-note").hidden, "no unreviewed note without live data");
    ok(p.d.querySelectorAll('.sections a').length === 7 && p.d.querySelector('.sections a[href="#market"]'), "nav should list the market watch");
  });
});

test("monthly limit: a link with cap leaves out pricier models, offers to lift it, and clearing it restores the pick", function () {
  var base = "http://localhost:8000/model-scout/index.html?task=rag&quality=frontier&speed=any&context=400000&in=60&out=3";
  var p = boot({ url: base + "&cap=100" });
  function top() { return p.d.querySelector("#top-pick h3").firstChild.textContent.trim(); }
  return settled(p).then(function () {
    ok(p.$("monthly-cap").value === "100", "field: " + p.$("monthly-cap").value);
    ok(top() === "DeepSeek V4.1 Flash", "top: " + top());
    ok(/Grok 4\.7[\s\S]*over your \$100 monthly limit/.test(p.$("excluded").textContent), "excluded: " + p.$("excluded").textContent.slice(0, 300));
    ok(/^\d+ left out: \d+ over your monthly limit/.test(p.$("excluded-summary").textContent), "summary: " + p.$("excluded-summary").textContent);
    var saved = null;
    p.w.URL.createObjectURL = function (blob) { saved = blob; return "blob:csv"; };
    p.w.URL.revokeObjectURL = function () {};
    p.$("table-csv").click();
    ok(saved && /Table saved as model-ranking-.*\.csv \(\d+ models\)/.test(p.$("share-status").textContent), "csv status: " + p.$("share-status").textContent);
    var lever = null;
    Array.prototype.forEach.call(p.d.querySelectorAll("#whatif .wi"), function (li) { if (/Remove the \$100 monthly limit/.test(li.textContent)) lever = li; });
    ok(lever && /Grok 4\.7/.test(lever.textContent), "cap lever: " + p.$("whatif").textContent.slice(0, 300));
    p.$("monthly-cap").value = ""; fire(p, "monthly-cap");
    ok(top() === "Grok 4.7" && !/cap=/.test(p.w.location.search), "cleared: " + top() + " " + p.w.location.search);
    p.$("monthly-cap").value = "-3"; fire(p, "monthly-cap");
    ok(/no monthly limit/.test(p.$("monthly-cap-error").textContent) && top() === "Grok 4.7", "bad value: " + p.$("monthly-cap-error").textContent);
  });
});

test("zero data retention: the checkbox drops models with no ZDR endpoint, reprices the rest, and goes in the link", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&speed=fast&budget=1&in=300&out=30&cache=50" });
  function top() { return p.d.querySelector("#top-pick h3").firstChild.textContent.trim(); }
  return settled(p).then(function () {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(p.$("zdr-date").textContent), "snapshot date: " + p.$("zdr-date").textContent);
    ok(top() === "DeepSeek V4.1 Flash", "top before: " + top());
    ok(/Zero data retention: \d+ endpoints/.test(p.$("cards").textContent), "card line missing");
    p.$("need-zdr").checked = true; fire(p, "need-zdr", "change");
    ok(top() !== "DeepSeek V4.1 Flash", "DeepSeek should drop once its higher ZDR price applies");
    ok(/Claude Fable 5\.\d[\s\S]*No zero-data-retention endpoint/.test(p.$("excluded").textContent), "excluded: " + p.$("excluded").textContent.slice(0, 300));
    ok(/(^|&|\?)zdr=1(&|$)/.test(p.w.location.search), "address: " + p.w.location.search);
    ok(Array.prototype.some.call(p.d.querySelectorAll("#whatif .wi"), function (li) { return /Drop the zero-data-retention requirement/.test(li.textContent); }), "drop lever missing");
  });
});

test("test kit: lists the shortlist plus the split pick, downloads a script, and is withheld for local only", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&quality=frontier&speed=any&context=400000&in=60&out=3" });
  var saved = null;
  p.w.URL.createObjectURL = function (blob) { saved = blob; return "blob:kit"; };
  p.w.URL.revokeObjectURL = function () {};
  return settled(p).then(function () {
    var items = p.d.querySelectorAll("#kit-models li");
    ok(items.length === 4 && /Grok 4\.7.*top pick/.test(items[0].textContent) && /DeepSeek V4\.1 Flash.*split traffic/.test(items[3].textContent),
      "kit list: " + p.$("kit-models").textContent);
    ok(!p.$("kit-download").disabled, "download should be on");
    p.$("kit-download").click();
    ok(saved && /model_scout_test\.py with 4 models/.test(p.$("kit-status").textContent), "status: " + p.$("kit-status").textContent);
    return saved.text ? saved.text() : null;
  }).then(function (text) {
    if (text !== null) ok(/"x-ai\/grok-4\.7", "Grok 4\.7"/.test(text) && /ZDR_ONLY = False/.test(text), "script body");
    p.$("local-only").checked = true; fire(p, "local-only", "change");
    ok(p.$("kit-download").disabled && /Local only/.test(p.$("kit-models").textContent), "local: " + p.$("kit-models").textContent);
  });
});

test("pinned scenario: pin, change settings, see what changed, go back, unpin", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&quality=frontier&speed=any&context=400000&in=60&out=3" });
  var copied = null;
  Object.defineProperty(p.w.navigator, "clipboard", { value: { writeText: function (t) { copied = t; return Promise.resolve(); } }, configurable: true });
  function top() { return p.d.querySelector("#top-pick h3").firstChild.textContent.trim(); }
  return settled(p).then(function () {
    ok(p.$("pin-bar").hidden, "bar starts hidden");
    p.$("pin-btn").click();
    ok(!p.$("pin-bar").hidden && /No settings changed/.test(p.$("pin-diff").textContent) && p.$("pin-restore").disabled, "fresh pin: " + p.$("pin-diff").textContent);
    p.$("monthly-cap").value = "100"; fire(p, "monthly-cap");
    ok(/Monthly spend limit: none to \$100 a month/.test(p.$("pin-diff").textContent), "diff: " + p.$("pin-diff").textContent);
    ok(/^Pinned: Grok 4\.7, score 85, \$138 a month\. Now: DeepSeek V4\.1 Flash/.test(p.$("pin-text").textContent), "text: " + p.$("pin-text").textContent);
    p.$("memo-copy").click();
    return waitFor(function () { return copied; }, "clipboard write");
  }).then(function () {
    ok(/## Compared with the pinned scenario\nPinned: Grok 4\.7[\s\S]*- Monthly spend limit: none to \$100 a month/.test(copied), "memo: " + copied.slice(0, 300));
    p.$("pin-restore").click();
    ok(p.$("monthly-cap").value === "" && top() === "Grok 4.7" && /No settings changed/.test(p.$("pin-diff").textContent), "restore: " + top());
    p.$("pin-clear").click();
    ok(p.$("pin-bar").hidden && p.d.activeElement === p.$("pin-btn"), "unpin");
  });
});

test("split traffic: pick a cheaper model and a share, see the cost, and the memo carries it", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&quality=frontier&speed=any&context=400000&in=60&out=3" });
  var copied = null;
  Object.defineProperty(p.w.navigator, "clipboard", { value: { writeText: function (t) { copied = t; return Promise.resolve(); } }, configurable: true });
  return settled(p).then(function () {
    var sel = p.$("route-model");
    ok(!sel.disabled && sel.options[0].textContent.indexOf("DeepSeek V4.1 Flash") === 0, "first option: " + sel.options[0].textContent);
    ok(/^Sending 50% of requests to DeepSeek V4\.1 Flash and the rest to Grok 4\.7/.test(p.$("route-readout").textContent), "readout: " + p.$("route-readout").textContent);
    ok(p.d.querySelectorAll("#route-bars .rb-fill").length === 2, "two bars");
    p.$("route-share").value = "80"; fire(p, "route-share");
    ok(p.$("route-share-out").textContent === "80%" && /^Sending 80%/.test(p.$("route-readout").textContent), "share: " + p.$("route-readout").textContent);
    sel.value = sel.options[1].value; fire(p, "route-model", "change");
    ok(p.$("route-readout").textContent.indexOf(sel.options[1].textContent.split(" (")[0]) > 0, "model change: " + p.$("route-readout").textContent);
    p.$("memo-copy").click();
    return waitFor(function () { return copied; }, "clipboard write");
  }).then(function () {
    ok(/## Split traffic\nSending 80%/.test(copied), "memo: " + copied.slice(0, 200));
    p.$("local-only").checked = true; fire(p, "local-only", "change");
    ok(p.$("route-model").disabled && /Local only/.test(p.$("route-readout").textContent), "local: " + p.$("route-readout").textContent);
  });
});

test("what if: levers show under the pick; apply one, then undo it", function () {
  var p = boot({ url: "http://localhost:8000/model-scout/index.html?task=rag&quality=frontier&speed=any&context=400000&in=60&out=3" });
  var first;
  return settled(p).then(function () {
    first = p.d.querySelector("#top-pick h3").firstChild.textContent.trim();
    var items = p.d.querySelectorAll("#whatif .wi");
    ok(items.length >= 2, "levers: " + items.length);
    var batch = null;
    Array.prototype.forEach.call(items, function (li) { if (/batch run/.test(li.textContent)) batch = li; });
    ok(batch && /comes first/.test(batch.textContent), "batch lever missing: " + p.$("whatif").textContent.slice(0, 200));
    var named = batch.querySelector(".wi-out strong").textContent;
    batch.querySelector("[data-lever]").click();
    ok(p.$("use-batch").checked && /batch=1/.test(p.w.location.search), "lever not applied: " + p.w.location.search);
    ok(p.d.querySelector("#top-pick h3").firstChild.textContent.trim() === named, "pick should be " + named);
    ok(!p.$("whatif-undo").hidden && /Applied: The work can wait/.test(p.$("whatif-status").textContent), "undo should show");
    p.$("whatif-undo").click();
    ok(!p.$("use-batch").checked && p.d.querySelector("#top-pick h3").firstChild.textContent.trim() === first && p.$("whatif-undo").hidden, "undo should restore the settings");
    batch = p.d.querySelector("#whatif [data-lever]");
    batch.click();
    p.$("quality").value = "good"; fire(p, "quality", "input");
    ok(p.$("whatif-undo").hidden && p.$("whatif-status").textContent === "", "a later edit should drop the undo");
  });
});

test("value map keyboard: focus lands on the top pick, arrows step by cost and score, Enter opens the card", function () {
  var p = boot({});
  return settled(p).then(function () {
    var map = p.$("value-map"), out = p.$("value-map-readout");
    ok(map.getAttribute("tabindex") === "0" && /Arrow keys/.test(map.getAttribute("aria-label")), "map should be focusable and say how to use it");
    function key(k) { map.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }
    function cursor() { var c = map.querySelector("circle.is-cursor"); return c && c.getAttribute("data-id"); }
    map.dispatchEvent(new p.w.FocusEvent("focus"));
    var top = p.d.querySelector("#top-pick h3").firstChild.textContent.trim();
    ok(cursor() && out.textContent.indexOf("#1 " + top) === 0, "focus should start on the top pick: " + out.textContent);
    key("Home");
    var cheapest = cursor();
    key("ArrowLeft");
    ok(cursor() === cheapest, "left at the cheapest end should stay put");
    key("ArrowRight");
    ok(cursor() && cursor() !== cheapest, "right should move to a pricier model");
    key("End"); var last = cursor(); key("ArrowRight");
    ok(cursor() === last, "right at the far end should stay put");
    key("ArrowUp"); key("ArrowDown");
    ok(/score \d/.test(out.textContent), "readout should name the model: " + out.textContent);
    var id = cursor(); key("Enter");
    var card = p.$("card-" + id);
    ok(card && !card.hidden && p.d.activeElement === card, "Enter should open and focus the card for " + id);
    map.dispatchEvent(new p.w.FocusEvent("focus")); key("Escape");
    ok(!cursor() && !/score \d/.test(out.textContent), "Escape should clear the cursor");
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
