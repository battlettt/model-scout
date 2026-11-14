/* Model Scout v2: client-side ranking engine and UI.
   The engine functions are pure and exported for node tests (tests/run_tests.js).
   The UI code only runs in a browser. The ranker calls no model: it fetches catalog.json
   (same folder) and the public OpenRouter model list. Only the "Ask a model" panel calls a
   model, when the user presses Send: OpenRouter chat with the user's own key (kept in
   localStorage, never in this repo), or Ollama on localhost with no key. */
(function (root) {
  "use strict";

  var STALE_AFTER_DAYS = 90;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
  var REQUIRED_FIELDS = [
    "id", "model", "provider", "kind", "context_window", "input_price_per_mtok",
    "output_price_per_mtok", "price_status", "latency_class", "strengths", "limits",
    "source", "last_verified"
  ];
  var PRICE_STATUSES = ["verified", "unverified", "self-hosted", "live"];
  var TASK_LABELS = {
    chat: "chat and writing", code: "coding", rag: "RAG (answering from your documents)",
    vision: "vision (images)", embeddings: "embeddings (search vectors)", agentic: "agentic work (tools, multi-step)"
  };
  var COMPONENT_LABELS = { cost: "cost", quality: "quality", latency: "speed", context: "context fit", privacy: "privacy" };
  var LATENCY_SCORE = { fast: 1, medium: 0.6, slow: 0.25 };
  var QUALITY_BAR_MIN = { basic: 1, good: 3, frontier: 5 };
  var HARDWARE_SCORE = { laptop: 1, workstation: 0.8, server: 0.5, cluster: 0.2, unknown: 0.4 };
  var HARDWARE_LABEL = {
    laptop: "a laptop", workstation: "a workstation with one strong GPU", server: "a multi-GPU server",
    cluster: "a GPU cluster", unknown: "unknown hardware (size not listed)"
  };
  var COST_LOG_LO = 0.05; // $/M blended price that scores 1.0
  var COST_LOG_HI = 30;   // $/M blended price that scores 0.0
  var SWITCH_MARGIN = 5;  // points a challenger must win by before switching is worth it
  var CAPABILITIES = ["tools", "json", "reasoning"];
  var CAPABILITY_LABELS = { tools: "tool calling", json: "JSON output", reasoning: "reasoning mode" };
  var MAX_CACHE_SHARE = 0.95;
  var ROBUST_SAMPLES = 300;
  var ROBUST_SPREAD = Math.log(2); // each weight is scaled by a factor between 1/2 and 2
  var DAYS_PER_MONTH = 365 / 12;

  // ---------- small helpers ----------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function round(x, d) { var p = Math.pow(10, d || 0); return Math.round(x * p) / p; }

  // ---------- cost math ----------
  /**
   * Prices per million tokens after the profile's batch and cache options. Null when a list price is unknown.
   * opts: { useBatch, cacheShare }. A batch price is used only when it is listed and not higher than the
   * standard price. Cached input is billed at the cache read price for cacheShare of the input tokens.
   * The cache discount is not combined with a batch price, and cache write fees are not modelled.
   */
  function effectivePrices(model, opts) {
    var pin = model.input_price_per_mtok, pout = model.output_price_per_mtok;
    if (!isNum(pin) || !isNum(pout)) return null;
    var o = opts || {}, r = { input: pin, output: pout, batch: false, cache: false };
    var bi = model.batch_input_price_per_mtok, bo = model.batch_output_price_per_mtok;
    if (o.useBatch && isNum(bi) && isNum(bo) && bi <= pin && bo <= pout) {
      r.input = bi; r.output = bo; r.batch = true;
    }
    var share = isNum(o.cacheShare) ? clamp(o.cacheShare, 0, MAX_CACHE_SHARE) : 0;
    var cr = model.cache_read_price_per_mtok;
    if (!r.batch && share > 0 && isNum(cr) && cr < r.input) {
      r.input = (1 - share) * r.input + share * cr;
      r.cache = true;
    }
    return r;
  }

  /** Monthly cost in USD. Prices are per million tokens. Returns null if a price is unknown. opts as in effectivePrices. */
  function monthlyCost(model, inputTokens, outputTokens, opts) {
    var e = effectivePrices(model, opts);
    if (!e) return null;
    return (inputTokens / 1e6) * e.input + (outputTokens / 1e6) * e.output;
  }

  /** Blended $/M for the user's input/output mix. Defaults to a 3:1 input:output mix. */
  function blendedPrice(model, inputTokens, outputTokens, opts) {
    var e = effectivePrices(model, opts);
    if (!e) return null;
    var i = inputTokens > 0 ? inputTokens : 0, o = outputTokens > 0 ? outputTokens : 0;
    if (i + o === 0) { i = 3; o = 1; }
    return (i * e.input + o * e.output) / (i + o);
  }

  /** Monthly volume in millions of tokens from requests per day and tokens per request. A month is 365/12 days. */
  function volumeFromRequests(perDay, inPerRequest, outPerRequest) {
    function n(x) { return isNum(x) && x > 0 ? x : 0; }
    var requests = n(perDay) * DAYS_PER_MONTH;
    return { requests: requests, inputM: requests * n(inPerRequest) / 1e6, outputM: requests * n(outPerRequest) / 1e6 };
  }

  // ---------- staleness ----------
  function parseDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    var t = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s);
    return isNaN(t) ? null : t;
  }

  /** Stale = verification date missing, unparseable, in the future, or older than maxDays. */
  function staleStatus(entry, now, maxDays) {
    var limit = isNum(maxDays) ? maxDays : STALE_AFTER_DAYS;
    var nowMs = now instanceof Date ? now.getTime() : (isNum(now) ? now : Date.now());
    var t = parseDate(entry && entry.last_verified);
    if (t === null) return { stale: true, ageDays: null, reason: "No verification date: treat these specs as unverified." };
    var age = Math.floor((nowMs - t) / DAY_MS);
    if (age < -1) return { stale: true, ageDays: age, reason: "Verification date is in the future, which is not possible: treat as unverified." };
    if (age > limit) return { stale: true, ageDays: age, reason: "Last verified " + age + " days ago (more than " + limit + "): prices or limits may have changed." };
    return { stale: false, ageDays: Math.max(age, 0), reason: "Verified " + Math.max(age, 0) + " days ago." };
  }

  // ---------- catalog validation ----------
  /** Returns a list of problems. An empty list means the entry is usable. */
  function validateEntry(e) {
    var errs = [];
    if (!e || typeof e !== "object") return ["entry is not an object"];
    REQUIRED_FIELDS.forEach(function (f) { if (!(f in e)) errs.push("missing field: " + f); });
    if (PRICE_STATUSES.indexOf(e.price_status) < 0) errs.push("price_status must be one of " + PRICE_STATUSES.join(", "));
    ["input_price_per_mtok", "output_price_per_mtok"].forEach(function (f) {
      var v = e[f];
      if (v === null) { if (e.price_status !== "unverified") errs.push(f + " is null but price_status is not unverified"); }
      else if (!isNum(v) || v < 0) errs.push(f + " must be a non-negative number or null with price_status unverified");
    });
    if (e.context_window !== null && (!isNum(e.context_window) || e.context_window <= 0)) errs.push("context_window must be a positive number or null");
    if (["fast", "medium", "slow", null].indexOf(e.latency_class) < 0) errs.push("latency_class must be fast, medium, slow, or null");
    if (e.quality_tier != null && (!isNum(e.quality_tier) || e.quality_tier < 1 || e.quality_tier > 5)) errs.push("quality_tier must be 1 to 5 or null");
    if (!Array.isArray(e.strengths)) errs.push("strengths must be a list");
    if (!Array.isArray(e.limits)) errs.push("limits must be a list");
    var hasSource = e.source && typeof e.source.name === "string" && e.source.name.length > 0;
    if (!hasSource) errs.push("missing source");
    if (parseDate(e.last_verified) === null && e.price_status !== "unverified") {
      errs.push("no valid last_verified date and not flagged unverified");
    }
    // optional fields, filled from OpenRouter's model list when the model is listed there
    ["cache_read_price_per_mtok", "batch_input_price_per_mtok", "batch_output_price_per_mtok", "max_output_tokens"].forEach(function (f) {
      if (e[f] != null && (!isNum(e[f]) || e[f] < 0)) errs.push(f + " must be a non-negative number or null");
    });
    if ((e.batch_input_price_per_mtok == null) !== (e.batch_output_price_per_mtok == null)) errs.push("batch prices must be both set or both null");
    if (e.capabilities != null) {
      if (typeof e.capabilities !== "object" || Array.isArray(e.capabilities)) errs.push("capabilities must be an object or null");
      else CAPABILITIES.forEach(function (k) { if (typeof e.capabilities[k] !== "boolean") errs.push("capabilities." + k + " must be true or false"); });
    }
    if (e.retires_on != null && parseDate(e.retires_on) === null) errs.push("retires_on must be a YYYY-MM-DD date or null");
    return errs;
  }

  /** Scheduled retirement from the listed expiration date, or null when none is listed. */
  function retirement(e, now) {
    var t = parseDate(e && e.retires_on);
    if (t === null) return null;
    var nowMs = now instanceof Date ? now.getTime() : (isNum(now) ? now : Date.now());
    var days = Math.ceil((t - nowMs) / DAY_MS), d = String(e.retires_on).slice(0, 10);
    if (days < 0) return { days: days, past: true, text: "Retired on " + d + ", the expiration date OpenRouter lists. Move off it." };
    return { days: days, past: false, text: "Scheduled to retire on " + d + (days === 0 ? " (today)" : " (in " + days + " day" + (days === 1 ? "" : "s") + ")") + ": plan the move now." };
  }

  /** Every flag the UI should show for an entry's data quality. */
  function dataFlags(e, now) {
    var flags = [];
    var st = staleStatus(e, now);
    if (st.stale) flags.push({ level: "warn", text: "Stale: " + st.reason });
    var ret = retirement(e, now);
    if (ret) flags.push({ level: "warn", text: ret.text });
    if (e.price_status === "unverified") flags.push({ level: "warn", text: "Price not verified: the figure shown is not confirmed by a current source." });
    if (e.unverified_fields && e.unverified_fields.length) {
      flags.push({ level: "warn", text: "Not verified: " + e.unverified_fields.join(", ").replace(/_/g, " ") + "." });
    }
    if (e.quality_tier == null) flags.push({ level: "info", text: "Quality not rated: this model came from live data and has no editorial tier." });
    if (e.latency_class == null) flags.push({ level: "info", text: "Speed not rated." });
    return flags;
  }

  // ---------- weights ----------
  /** Weights respond to the user's constraints and always sum to 1. */
  function computeWeights(p) {
    var w = { cost: 1, quality: 1, latency: 0.6, context: 0.6, privacy: 0.15 };
    if (isNum(p.budget) && p.budget > 0) {
      if (p.budget <= 1) w.cost += 1.5;
      else if (p.budget <= 5) w.cost += 0.6;
      else w.cost += 0.2;
    }
    if (p.quality === "frontier") w.quality += 1.5;
    else if (p.quality === "good") w.quality += 0.5;
    else if (p.quality === "basic") { w.quality -= 0.4; w.cost += 0.4; }
    if (p.latency === "fast") w.latency += 1.2;
    else if (p.latency === "balanced") w.latency += 0.3;
    else if (p.latency === "any") w.latency = 0.2;
    var need = p.contextNeed || 0;
    if (need >= 200000) w.context += 1.2;
    else if (need >= 32000) w.context += 0.4;
    if (p.localOnly) w.privacy += 1.5;
    if (p.taskType === "agentic") w.quality += 0.3;
    if (p.taskType === "embeddings") w.cost += 0.3;
    var sum = 0, k;
    for (k in w) sum += w[k];
    for (k in w) w[k] = w[k] / sum;
    return w;
  }

  // ---------- scoring ----------
  function costScoreFromPrice(b) {
    if (b <= 0) return 1;
    var s = 1 - (Math.log10(b) - Math.log10(COST_LOG_LO)) / (Math.log10(COST_LOG_HI) - Math.log10(COST_LOG_LO));
    return clamp(s, 0, 1);
  }

  /** Score one model against a profile. Returns components (0..1), total (0..100), flags, or an exclusion. */
  function scoreModel(m, p, w, now) {
    var r = { model: m, excluded: false, excludeReason: "", components: {}, total: 0, flags: [], notes: [] };
    var task = p.taskType || "chat";
    var isEmbedTask = task === "embeddings";
    if (isEmbedTask && m.kind !== "embedding") return excl(r, "Not an embedding model, and your task is embeddings.");
    if (!isEmbedTask && m.kind === "embedding") return excl(r, "Embedding model: it makes search vectors and cannot generate text.");
    var mods = m.input_modalities || ["text"];
    var needMod = p.modality || "text";
    if (task === "vision" && needMod === "text") needMod = "image";
    if (mods.indexOf(needMod) < 0) return excl(r, "Does not accept " + needMod + " input.");
    if (p.localOnly && !m.open_weights) return excl(r, "Hosted only: no downloadable weights, and your profile is local-only.");
    if (!isEmbedTask) {
      for (var ci = 0; ci < CAPABILITIES.length; ci++) {
        var ck = CAPABILITIES[ci], label = CAPABILITY_LABELS[ck];
        if (!(p.needs && p.needs[ck])) continue;
        if (m.capabilities && m.capabilities[ck] === false) return excl(r, "Does not support " + label + " (OpenRouter's model list), and your profile requires it.");
        if (!m.capabilities) r.flags.push(label.charAt(0).toUpperCase() + label.slice(1) + " not confirmed: no capability data for this model.");
      }
    }

    var c = r.components;
    // cost
    if (p.localOnly) {
      var hw = m.local_hardware || "unknown";
      c.cost = HARDWARE_SCORE[hw] != null ? HARDWARE_SCORE[hw] : HARDWARE_SCORE.unknown;
      r.notes.push("Self-hosted: needs " + (HARDWARE_LABEL[hw] || HARDWARE_LABEL.unknown) + ". Cost score reflects hardware size, not a per-token price.");
    } else {
      var b = blendedPrice(m, p.inputTokens, p.outputTokens, p);
      if (b === null) { c.cost = 0.5; r.flags.push("Price unknown, so cost was scored as average."); }
      else {
        c.cost = costScoreFromPrice(b);
        if (isNum(p.budget) && p.budget > 0 && b > p.budget) {
          c.cost *= 0.25;
          r.flags.push("Over budget: about $" + round(b, 3) + " per million tokens for your mix, above your $" + p.budget + " limit.");
        }
        costNotes(r, m, p);
      }
    }
    // quality
    if (m.quality_tier == null) { c.quality = 0.5; r.flags.push("Quality not rated (live-only model), scored as average."); }
    else {
      c.quality = m.quality_tier / 5;
      var bar = QUALITY_BAR_MIN[p.quality] || 1;
      if (m.quality_tier < bar) { c.quality *= 0.5; r.belowBar = true; r.flags.push("Below your quality bar (" + p.quality + ")."); }
    }
    // latency
    if (m.latency_class == null) c.latency = 0.5;
    else {
      c.latency = LATENCY_SCORE[m.latency_class];
      if (p.latency === "fast" && m.latency_class === "slow") r.flags.push("Likely slower than your speed target.");
    }
    // context
    var need = p.contextNeed || 0;
    if (isEmbedTask) {
      c.context = 1;
      if (isNum(m.context_window) && need > m.context_window) r.notes.push("Embeddings work per chunk: split documents into pieces under " + fmtTokens(m.context_window) + " tokens.");
    }
    else if (!isNum(m.context_window)) { c.context = 0.5; r.flags.push("Context window unknown."); }
    else if (need <= 0 || m.context_window >= need) c.context = 1;
    else {
      c.context = 0.5 * Math.pow(m.context_window / need, 2);
      r.flags.push("Context too short: " + fmtTokens(m.context_window) + " tokens, you need " + fmtTokens(need) + ".");
    }
    // privacy
    c.privacy = m.open_weights ? 1 : 0.3;

    var sum = 0;
    Object.keys(w).forEach(function (k) { sum += w[k] * c[k]; });
    var fit = 1;
    if (Array.isArray(m.task_fit) && m.task_fit.indexOf(task) < 0) {
      fit = 0.7;
      r.flags.push("Not positioned for " + (TASK_LABELS[task] || task) + ".");
    }
    if (r.belowBar) fit *= 0.8;
    r.fit = fit;
    r.total = round(100 * sum * fit, 1);
    return r;
  }

  function excl(r, reason) { r.excluded = true; r.excludeReason = reason; return r; }

  /** Notes on how the batch and cache options changed this model's price. */
  function costNotes(r, m, p) {
    var e = effectivePrices(m, p);
    if (!e) return;
    if (p.useBatch) {
      r.notes.push(e.batch ? "Batch price used: " + fmtPrice(e.input) + " in / " + fmtPrice(e.output) + " out per 1M tokens, for work that can wait for a batch run." :
        "No lower batch price is listed for this model, so the standard price is used.");
    }
    if (isNum(p.cacheShare) && p.cacheShare > 0 && !e.batch) {
      r.notes.push(e.cache ? "Cached input billed at " + fmtPrice(m.cache_read_price_per_mtok) + " per 1M for " + Math.round(clamp(p.cacheShare, 0, MAX_CACHE_SHARE) * 100) + "% of input tokens. Cache write fees are not included." :
        "No cache read price is listed, so all input is billed at the full input price.");
    }
  }

  /** Rank all models. Ties are broken by lower monthly cost, then by name. */
  function rankModels(models, p, now) {
    var w = computeWeights(p);
    var all = models.map(function (m) { return scoreModel(m, p, w, now); });
    var ranked = all.filter(function (r) { return !r.excluded; });
    ranked.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var ca = monthlyCost(a.model, p.inputTokens, p.outputTokens, p), cb = monthlyCost(b.model, p.inputTokens, p.outputTokens, p);
      if (ca !== cb) return (ca === null ? Infinity : ca) - (cb === null ? Infinity : cb);
      return a.model.model.localeCompare(b.model.model);
    });
    ranked.forEach(function (r, i) { r.rank = i + 1; r.explain = explain(r, ranked[0], ranked[1], p, w); });
    return { weights: w, ranked: ranked, excluded: all.filter(function (r) { return r.excluded; }) };
  }

  // ---------- plain-language reasons ----------
  var GOOD_WORDS = {
    cost: "low cost for your volume", quality: "a high quality tier", latency: "fast responses",
    context: "enough context for your inputs", privacy: "open weights you can run yourself"
  };
  var BAD_WORDS = {
    cost: "a higher price", quality: "a lower quality tier", latency: "slower responses",
    context: "a context window shorter than your longest input", privacy: "sending data to a hosted provider"
  };

  function explain(r, top, second, p, w) {
    var c = r.components, keys = Object.keys(w);
    var contrib = keys.map(function (k) { return { k: k, v: w[k] * c[k], s: c[k] }; });
    contrib.sort(function (a, b) { return b.v - a.v; });
    var goods = contrib.filter(function (x) { return x.s >= 0.6; }).slice(0, 2).map(function (x) { return GOOD_WORDS[x.k]; });
    var why = goods.length ? "Scores well on " + goods.join(" and ") + ", which your profile weights heavily." :
      "No single strength stands out, but it is the best of what remains under your constraints.";
    if (r.model.strengths && r.model.strengths[0]) why += " " + r.model.strengths[0] + ".";

    var bads = keys.filter(function (k) { return c[k] < 0.5; }).sort(function (a, b) { return w[b] - w[a]; }).map(function (k) { return BAD_WORDS[k]; });
    var trade = [];
    if (bads.length) trade.push("You accept " + bads.slice(0, 2).join(" and ") + ".");
    var other = r === top ? second : top;
    if (other) {
      var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p), oc = monthlyCost(other.model, p.inputTokens, p.outputTokens, p);
      var name = other.model.model;
      if (!p.localOnly && mc !== null && oc !== null && (p.inputTokens + p.outputTokens) > 0 && Math.abs(mc - oc) >= 0.01) {
        trade.push(mc > oc ? "Costs " + fmtMoney(mc - oc) + " more per month than " + name + "." :
          "Saves " + fmtMoney(oc - mc) + " per month versus " + name + ".");
      }
      var qa = r.model.quality_tier, qb = other.model.quality_tier;
      if (qa != null && qb != null && qa < qb) trade.push("Rated a lower quality tier than " + name + " (" + qa + " vs " + qb + " of 5).");
      if (r === top) {
        var lead = round(r.total - other.total, 1);
        trade.push(lead > 0 ? "Leads " + name + " by " + lead + " points." : "Ties with " + name + " on score and ranks first on lower monthly cost or name, so treat the two as equal.");
      }
    }
    if (r.model.limits && r.model.limits[0]) trade.push("Known limit: " + r.model.limits[0] + ".");
    return { why: why, tradeoffs: trade.join(" ") };
  }

  // ---------- switch check ----------
  /** Does any candidate beat the user's current model under their weights? */
  function switchCheck(models, currentId, p, now) {
    var res = rankModels(models, p, now);
    var cur = null;
    res.ranked.forEach(function (r) { if (r.model.id === currentId) cur = r; });
    var exc = null;
    res.excluded.forEach(function (r) { if (r.model.id === currentId) exc = r; });
    if (!cur) return { found: !!exc, excluded: !!exc, excludeReason: exc ? exc.excludeReason : "", better: [], current: null };
    var better = res.ranked.filter(function (r) { return r.total > cur.total; }).map(function (r) {
      return { model: r.model, total: r.total, margin: round(r.total - cur.total, 1) };
    });
    return {
      found: true, excluded: false, current: cur, better: better,
      worthSwitching: better.length > 0 && better[0].margin >= SWITCH_MARGIN,
      stale: staleStatus(cur.model, now), retirement: retirement(cur.model, now)
    };
  }

  // ---------- robustness of the top pick ----------
  /** Small seeded random number generator (mulberry32), so the same profile always gives the same answer. */
  function seededRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * How often does each model come first when the weights are nudged at random? Each sample scales every
   * weight by a factor between 1/2 and 2, renormalises, and rescores every ranked model with the same
   * factor scores. Ties go to the higher-ranked model. Returns null when nothing is ranked.
   * runnerUp says whether the second model ties the top pick on every factor (no weighting can separate
   * them) or is matched or beaten on every factor (no weighting can put it first).
   */
  function robustness(res, opts) {
    opts = opts || {};
    var ranked = res && res.ranked;
    if (!ranked || !ranked.length) return null;
    var n = opts.samples || ROBUST_SAMPLES, spread = isNum(opts.spread) ? opts.spread : ROBUST_SPREAD;
    var w = res.weights, keys = Object.keys(w), rnd = seededRandom(opts.seed || 20261113);
    var wins = ranked.map(function () { return 0; });
    for (var s = 0; s < n; s++) {
      var ws = {}, sum = 0;
      keys.forEach(function (k) { ws[k] = w[k] * Math.exp(spread * (2 * rnd() - 1)); sum += ws[k]; });
      var best = 0, bestV = -Infinity;
      for (var i = 0; i < ranked.length; i++) {
        var r = ranked[i], v = 0;
        for (var j = 0; j < keys.length; j++) v += (ws[keys[j]] / sum) * r.components[keys[j]];
        v *= r.fit;
        if (v > bestV + 1e-12) { bestV = v; best = i; }
      }
      wins[best]++;
    }
    var shares = ranked.map(function (r, i) { return { model: r.model, rank: r.rank, share: wins[i] / n }; })
      .filter(function (x) { return x.share > 0; })
      .sort(function (a, b) { return b.share - a.share || a.rank - b.rank; });
    var topShare = wins[0] / n, runnerUp = null;
    if (ranked[1]) {
      var a = ranked[0], b = ranked[1], ge = true, eq = true;
      keys.forEach(function (k) {
        var x = a.components[k] * a.fit, y = b.components[k] * b.fit;
        if (x < y - 1e-9) ge = false;
        if (Math.abs(x - y) > 1e-9) eq = false;
      });
      runnerUp = { model: b.model, twin: eq, dominated: ge && !eq };
    }
    return {
      samples: n, topShare: topShare, shares: shares, runnerUp: runnerUp,
      verdict: runnerUp && runnerUp.twin ? "tie" : topShare >= 0.8 ? "stable" : topShare >= 0.5 ? "likely" : "close"
    };
  }

  // ---------- live data (OpenRouter) ----------
  function perMillion(x) { var v = parseFloat(x); return isFinite(v) ? round(v * 1e6, 4) : null; }

  /**
   * Facts beyond price from one OpenRouter list entry: capabilities (from supported_parameters), cache read
   * price, batch prices (from the ":batch" variant), output limit, retirement date, and listing date.
   * Every key is present; null means OpenRouter does not list it.
   */
  function liveFacts(m, byId) {
    var f = { capabilities: null, cache_read_price_per_mtok: null, batch_input_price_per_mtok: null,
      batch_output_price_per_mtok: null, max_output_tokens: null, retires_on: null, listed_on: null };
    if (!m) return f;
    var sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    if (sp) {
      f.capabilities = { tools: sp.indexOf("tools") >= 0,
        json: sp.indexOf("structured_outputs") >= 0 || sp.indexOf("response_format") >= 0,
        reasoning: sp.indexOf("reasoning") >= 0 || sp.indexOf("include_reasoning") >= 0 };
    }
    var cr = perMillion(m.pricing && m.pricing.input_cache_read);
    if (cr !== null && cr >= 0) f.cache_read_price_per_mtok = cr;
    var b = byId && byId[m.id + ":batch"];
    if (b && b.pricing) {
      var bi = perMillion(b.pricing.prompt), bo = perMillion(b.pricing.completion);
      if (bi !== null && bo !== null && bi >= 0 && bo >= 0) { f.batch_input_price_per_mtok = bi; f.batch_output_price_per_mtok = bo; }
    }
    var tp = m.top_provider || {};
    if (isNum(tp.max_completion_tokens) && tp.max_completion_tokens > 0) f.max_output_tokens = tp.max_completion_tokens;
    if (typeof m.expiration_date === "string" && parseDate(m.expiration_date) !== null) f.retires_on = m.expiration_date.slice(0, 10);
    if (isNum(m.created) && m.created > 0) f.listed_on = new Date(m.created * 1000).toISOString().slice(0, 10);
    return f;
  }

  /** Merge OpenRouter data into the catalog. Returns { models, matched, changed, liveOnly }. */
  function mergeLive(catalogModels, orData, fetchedAt) {
    var byId = {};
    (orData || []).forEach(function (m) { if (m && m.id) byId[m.id] = m; });
    var stamp = fetchedAt.toISOString();
    var matched = 0, changed = [];
    var merged = catalogModels.map(function (e) {
      var live = e.openrouter_id && byId[e.openrouter_id];
      if (!live || !live.pricing) return e;
      var pin = perMillion(live.pricing.prompt), pout = perMillion(live.pricing.completion);
      if (pin === null || pout === null || pin < 0 || pout < 0) return e;
      matched++;
      var copy = JSON.parse(JSON.stringify(e));
      var diffs = [];
      if (pin !== e.input_price_per_mtok) diffs.push("input price $" + e.input_price_per_mtok + " to $" + pin);
      if (pout !== e.output_price_per_mtok) diffs.push("output price $" + e.output_price_per_mtok + " to $" + pout);
      if (isNum(live.context_length) && live.context_length !== e.context_window) diffs.push("context " + fmtTokens(e.context_window) + " to " + fmtTokens(live.context_length));
      copy.input_price_per_mtok = pin;
      copy.output_price_per_mtok = pout;
      if (isNum(live.context_length)) copy.context_window = live.context_length;
      var facts = liveFacts(live, byId);
      Object.keys(facts).forEach(function (k) { copy[k] = facts[k]; });
      copy.price_status = "live";
      copy.last_verified = stamp;
      copy.live = { fetchedAt: stamp, changes: diffs };
      if (diffs.length) changed.push({ model: e.model, changes: diffs });
      return copy;
    });
    var known = {};
    catalogModels.forEach(function (e) { if (e.openrouter_id) known[e.openrouter_id] = true; });
    var liveOnly = [];
    Object.keys(byId).forEach(function (id) {
      var m = byId[id];
      if (known[id] || /:(free|batch|extended|beta)$/.test(id) || id.indexOf("openrouter/") === 0) return;
      var arch = m.architecture || {};
      var outs = arch.output_modalities || ["text"];
      if (outs.length !== 1 || outs[0] !== "text") return;
      var pin = perMillion(m.pricing && m.pricing.prompt), pout = perMillion(m.pricing && m.pricing.completion);
      if (pin === null || pout === null || pin < 0 || pout < 0) return;
      var provider = id.split("/")[0];
      var entry = {
        id: "live:" + id, model: String(m.name || id).split(": ").pop(), provider: provider, kind: "generation",
        openrouter_id: id, context_window: isNum(m.context_length) ? m.context_length : null,
        input_price_per_mtok: pin, output_price_per_mtok: pout, price_status: "live", unverified_fields: [],
        latency_class: null, quality_tier: null, task_fit: null,
        input_modalities: (arch.input_modalities || ["text"]).filter(function (x) { return ["text", "image", "file", "audio", "video"].indexOf(x) >= 0; }),
        open_weights: !!m.hugging_face_id, local_hardware: m.hugging_face_id ? "unknown" : null,
        strengths: ["Listed live on OpenRouter"], limits: ["Not reviewed by Model Scout: quality and speed are not rated"],
        source: { name: "OpenRouter live model list, fetched " + stamp, url: "https://openrouter.ai/" + id },
        last_verified: stamp, live: { fetchedAt: stamp, changes: [] }, liveOnly: true
      };
      var lf = liveFacts(m, byId);
      Object.keys(lf).forEach(function (k) { entry[k] = lf[k]; });
      liveOnly.push(entry);
    });
    return { models: merged, matched: matched, changed: changed, liveOnly: liveOnly };
  }

  // ---------- task description hints ----------
  /** Simple keyword matching on the plain-language description. Returns suggested settings and why. */
  function suggestFromText(text) {
    var t = String(text || "").toLowerCase(), s = {}, why = [];
    function has(re) { return re.test(t); }
    if (has(/\b(embed|embedding|vector|semantic search|similarity)\b/)) { s.taskType = "embeddings"; why.push("mentions embeddings or vectors"); }
    else if (has(/\b(agent|agentic|tool use|tools|multi-step|autonomous|browse)\b/)) { s.taskType = "agentic"; why.push("mentions agents or tools"); }
    else if (has(/\b(code|coding|program|refactor|bug|repo|pull request|typescript|python)\b/)) { s.taskType = "code"; why.push("mentions code"); }
    else if (has(/\b(image|photo|screenshot|picture|diagram|ocr|scan)\b/)) { s.taskType = "vision"; s.modality = "image"; why.push("mentions images"); }
    else if (has(/\b(rag|retriev|knowledge base|docs|documents|pdf|manual)\b/)) { s.taskType = "rag"; why.push("mentions documents or retrieval"); }
    else if (has(/\b(chat|support|assistant|write|writing|summar|classif|email)\b/)) { s.taskType = "chat"; why.push("mentions chat, writing, or classification"); }
    if (has(/\b(audio|voice|speech|podcast|call recording)\b/)) { s.modality = "audio"; why.push("mentions audio"); }
    if (has(/\b(video)\b/)) { s.modality = "video"; why.push("mentions video"); }
    if (has(/\b(private|confidential|on-prem|on prem|offline|local|hipaa|gdpr|air-gapped|air gapped)\b/)) { s.localOnly = true; why.push("mentions privacy or local use"); }
    if (has(/\b(cheap|budget|low cost|inexpensive|millions of|high volume|classifier)\b/)) { s.budget = 1; why.push("mentions cost or high volume"); }
    if (has(/\b(real-time|realtime|fast|instant|latency|live chat)\b/)) { s.latency = "fast"; why.push("mentions speed"); }
    if (has(/\b(hardest|frontier|best possible|research|complex reasoning|math proof|critical)\b/)) { s.quality = "frontier"; why.push("mentions top quality"); }
    if (has(/\b(long document|long documents|entire codebase|whole codebase|books?|contracts|transcripts|hundreds of pages)\b/)) { s.contextNeed = 400000; why.push("mentions long inputs"); }
    if (s.taskType === "agentic" || has(/\b(function calling|tool calls?|call (our|an|the) api)\b/)) { s.tools = true; why.push("needs tool calling"); }
    if (has(/\b(json|structured output|schema|extract fields)\b/)) { s.json = true; why.push("mentions JSON or structured output"); }
    if (has(/\b(overnight|nightly|batch|backfill)\b/)) { s.useBatch = true; s.latency = "any"; why.push("mentions batch or overnight work"); }
    return { settings: s, why: why };
  }

  // ---------- profile settings: presets and shareable links ----------
  // Settings are what the form shows (volumes in millions, cache share as a fraction). profileFromSettings
  // turns them into the profile the engine scores against.
  var DEFAULT_SETTINGS = {
    taskType: "chat", modality: "text", quality: "good", latency: "balanced", contextNeed: 32000, budget: null,
    localOnly: false, inputM: 50, outputM: 10, cacheShare: 0, useBatch: false, tools: false, json: false, reasoning: false
  };
  var SETTING_CHOICES = {
    taskType: ["chat", "code", "rag", "vision", "embeddings", "agentic"],
    modality: ["text", "image", "file", "audio", "video"],
    quality: ["basic", "good", "frontier"],
    latency: ["balanced", "fast", "any"],
    contextNeed: [8000, 32000, 128000, 200000, 400000, 1000000, 2000000],
    cacheShare: [0, 0.25, 0.5, 0.75, 0.9]
  };
  var BOOL_SETTINGS = ["localOnly", "useBatch", "tools", "json", "reasoning"];
  var URL_KEYS = {
    taskType: "task", modality: "input", quality: "quality", latency: "speed", contextNeed: "context", budget: "budget",
    localOnly: "local", inputM: "in", outputM: "out", cacheShare: "cache", useBatch: "batch", tools: "tools", json: "json", reasoning: "reasoning"
  };
  var PRESETS = [
    { id: "support", name: "Support bot", description: "Answer customer questions from our help center articles, quickly, at high volume",
      settings: { taskType: "rag", latency: "fast", budget: 1, inputM: 300, outputM: 30, cacheShare: 0.5 } },
    { id: "coding-agent", name: "Coding agent", description: "An agent that reads a repository, calls tools, runs the tests, and opens pull requests",
      settings: { taskType: "agentic", quality: "frontier", contextNeed: 200000, inputM: 200, outputM: 10, cacheShare: 0.75, tools: true } },
    { id: "bulk", name: "Bulk tagging", description: "Tag a million product reviews a month by topic and sentiment, returned as JSON, overnight",
      settings: { quality: "basic", latency: "any", contextNeed: 8000, budget: 0.5, inputM: 400, outputM: 20, useBatch: true, json: true } },
    { id: "contracts", name: "Contract review", description: "Read whole contracts and flag unusual clauses for a lawyer to check",
      settings: { taskType: "rag", quality: "frontier", latency: "any", contextNeed: 400000, inputM: 60, outputM: 3 } },
    { id: "private", name: "On our own servers", description: "Summarise confidential internal documents without the data leaving our machines",
      settings: { localOnly: true, inputM: 20, outputM: 4 } },
    { id: "screens", name: "Read scans", description: "Pull fields out of scanned invoices and screenshots as JSON",
      settings: { taskType: "vision", modality: "image", inputM: 40, outputM: 4, json: true } },
    { id: "search", name: "Semantic search", description: "Embed our document library so people can search it by meaning",
      settings: { taskType: "embeddings", contextNeed: 8000, inputM: 500, outputM: 0 } }
  ];

  function withDefaults(s) {
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = s && s[k] !== undefined ? s[k] : DEFAULT_SETTINGS[k]; });
    return out;
  }

  /** Full settings for a preset id, or null for an unknown id. */
  function presetSettings(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return withDefaults(PRESETS[i].settings);
    return null;
  }

  /** The engine's profile from form settings. */
  function profileFromSettings(s) {
    var f = withDefaults(s);
    function tok(m) { return isNum(m) && m > 0 ? m * 1e6 : 0; }
    return {
      taskType: f.taskType, modality: f.modality, quality: f.quality, latency: f.latency,
      contextNeed: isNum(f.contextNeed) ? f.contextNeed : 0, budget: isNum(f.budget) && f.budget > 0 ? f.budget : null,
      localOnly: !!f.localOnly, inputTokens: tok(f.inputM), outputTokens: tok(f.outputM),
      cacheShare: isNum(f.cacheShare) ? clamp(f.cacheShare, 0, MAX_CACHE_SHARE) : 0, useBatch: !!f.useBatch,
      needs: { tools: !!f.tools, json: !!f.json, reasoning: !!f.reasoning }
    };
  }

  /** Settings as a query string, so a ranking can be shared as a link. Defaults are left out. The task description is never included. */
  function encodeSettings(s) {
    var f = withDefaults(s), parts = [];
    Object.keys(URL_KEYS).forEach(function (k) {
      var v = f[k];
      if (v === DEFAULT_SETTINGS[k] || v === null || v === undefined) return;
      if (k === "cacheShare") v = Math.round(v * 100);
      if (v === true) v = 1;
      if (v === false) v = 0;
      parts.push(URL_KEYS[k] + "=" + encodeURIComponent(String(v)));
    });
    return parts.join("&");
  }

  function parseSetting(k, raw) {
    var x;
    if (k === "contextNeed") { x = Number(raw); return SETTING_CHOICES.contextNeed.indexOf(x) >= 0 ? x : undefined; }
    if (k === "cacheShare") { x = Number(raw) / 100; return SETTING_CHOICES.cacheShare.indexOf(x) >= 0 ? x : undefined; }
    if (SETTING_CHOICES[k]) return SETTING_CHOICES[k].indexOf(raw) >= 0 ? raw : undefined;
    if (BOOL_SETTINGS.indexOf(k) >= 0) return raw === "1" ? true : raw === "0" ? false : undefined;
    if (raw === "" || !/^\d*\.?\d+$/.test(raw)) return undefined;
    x = Number(raw);
    if (k === "budget") return x > 0 && x <= 1000 ? x : undefined;
    if (k === "inputM" || k === "outputM") return x >= 0 && x <= 1e6 ? x : undefined;
    return undefined;
  }

  /** Settings from a query string. Unknown keys and invalid values are skipped and listed in ignored. */
  function decodeSettings(qs) {
    var settings = {}, ignored = [], rev = {};
    Object.keys(URL_KEYS).forEach(function (k) { rev[URL_KEYS[k]] = k; });
    String(qs || "").replace(/^\?/, "").split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("="), key, raw;
      try {
        key = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
        raw = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
      } catch (e) { ignored.push(pair); return; }
      var k = rev[key];
      if (!k) { ignored.push(key); return; }
      var v = parseSetting(k, raw);
      if (v === undefined) ignored.push(key); else settings[k] = v;
    });
    return { settings: settings, ignored: ignored };
  }

  // ---------- formatting ----------
  function fmtMoney(v) {
    if (v === null || !isNum(v)) return "unknown";
    if (v === 0) return "$0";
    if (v < 0.01) return "under $0.01";
    if (v < 100) return "$" + v.toFixed(2);
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  function fmtPrice(v) { return isNum(v) ? "$" + (v < 0.1 ? String(round(v, 4)) : v.toFixed(2)) : "unknown"; }
  function fmtTokens(n) {
    if (!isNum(n)) return "unknown";
    if (n >= 1e6) return round(n / 1e6, 2) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  }

  // ---------- chat: OpenRouter (your key) or local Ollama (no key) ----------
  // Pure helpers: they build requests and read answers, and take fetch and storage as
  // arguments, so node tests can drive them with stubs. No key is ever stored in code.
  var OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
  var OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
  var LOCAL_MODEL = "dolphin3";
  var LOCAL_LABEL = "dolphin3 (local Ollama)";
  var DEFAULT_CHAT_MODEL = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
  var FEATURED_CHAT_MODELS = [
    { id: DEFAULT_CHAT_MODEL, name: "Venice Uncensored" },
    { id: "nousresearch/hermes-3-llama-3.1-70b", name: "Nous Hermes 3 70B" }
  ];
  var KEY_STORAGE = "model-scout.openrouter-key";
  var CHAT_TIMEOUT_MS = 120000; // no answer (or no new streamed text) for this long stops the request
  var SIDE_STATUS = {
    idle: { cls: "idle", text: "Ready" }, sending: { cls: "live", text: "Sending" },
    done: { cls: "ok", text: "Done" }, error: { cls: "warn", text: "Error" }
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /** Request for one chat call. OpenRouter needs a key (sent as a Bearer header); local Ollama always uses dolphin3 and no key. */
  function buildChatRequest(provider, model, messages, key, stream) {
    var msgs = (messages || []).map(function (m) { return { role: m.role, content: String(m.content) }; });
    if (provider === "local") {
      return {
        ok: true, provider: "local", model: LOCAL_MODEL, stream: !!stream, url: OLLAMA_CHAT_URL,
        init: { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: LOCAL_MODEL, messages: msgs, stream: !!stream }) }
      };
    }
    var k = String(key || "").trim();
    if (!k) return { ok: false, code: "no-key", error: "No OpenRouter key saved. Paste your key in the key box and press Save key." };
    if (!model) return { ok: false, code: "no-model", error: "Choose a model first." };
    var body = { model: model, messages: msgs };
    if (stream) body.stream = true;
    return {
      ok: true, provider: "openrouter", model: model, stream: !!stream, url: OPENROUTER_CHAT_URL,
      init: { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + k }, body: JSON.stringify(body) }
    };
  }

  /** The error message inside an OpenRouter ({ error: { message } }) or Ollama ({ error: "..." }) body. */
  function chatErrorDetail(j) {
    if (!j || !j.error) return "";
    var e = j.error, msg = typeof e === "string" ? e : (e.message || "");
    return String(msg).slice(0, 300);
  }

  /** The answer text in a non-streamed response, or null when the shape is not recognised. */
  function chatText(provider, j) {
    if (!j || typeof j !== "object") return null;
    if (provider === "local") return j.message && typeof j.message.content === "string" ? j.message.content : null;
    var c = j.choices && j.choices[0];
    return c && c.message && typeof c.message.content === "string" ? c.message.content : null;
  }

  function httpErrorText(provider, status, detail) {
    var who = provider === "local" ? "Ollama" : "OpenRouter";
    var said = detail ? " " + who + " said: " + detail : "";
    if (provider !== "local") {
      if (status === 401) return "OpenRouter rejected the key (HTTP 401). Check or replace the key in the key box." + said;
      if (status === 402) return "Your OpenRouter account does not have enough credits for this model (HTTP 402)." + said;
      if (status === 403) return "OpenRouter refused this request (HTTP 403), for example a moderation block." + said;
      if (status === 404) return "OpenRouter does not serve this model right now (HTTP 404). Pick another model." + said;
      if (status === 429) return "OpenRouter is rate limiting this key or model (HTTP 429). Wait a moment and try again." + said;
    } else if (status === 404) {
      return "Ollama does not have the dolphin3 model (HTTP 404). Run: ollama pull dolphin3." + said;
    }
    return who + " returned HTTP " + status + "." + said;
  }

  /** Can this page reach Ollama? Only when served over plain http from this computer. */
  function localModeCheck(href) {
    var u;
    try { u = new URL(String(href)); } catch (e) { return { ok: false, text: "Could not tell where this page is served from." }; }
    var host = u.hostname.replace(/^\[|\]$/g, "");
    var isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || /\.localhost$/.test(host);
    if (u.protocol === "http:" && isLocal) return { ok: true, text: "This page is served from " + u.host + ", so it can reach Ollama on this computer." };
    if (u.protocol === "file:") return { ok: false, text: "This page is open as a file. Serve the folder from localhost (python3 -m http.server 8000) so it can reach Ollama." };
    return { ok: false, text: "This page is served from " + u.host + " over " + u.protocol.replace(":", "") + ", so the browser will block calls to Ollama. Serve Model Scout from localhost to use local mode." };
  }

  function networkErrorText(provider, err, pageUrl, timeoutMs) {
    if (err && err.name === "AbortError") return "No answer for " + Math.round(timeoutMs / 1000) + " seconds, so the request was stopped. Try again or pick a faster model.";
    var why = err && err.message ? err.message : "unknown error";
    if (provider === "local") {
      var where = localModeCheck(pageUrl);
      return "Could not reach Ollama on localhost port 11434 (" + why + "). Check that Ollama is running and has dolphin3." + (where.ok ? "" : " " + where.text);
    }
    return "Could not reach OpenRouter (" + why + "). Check your connection, or whether an extension blocks openrouter.ai.";
  }

  /** Split a growing stream buffer into whole lines plus the unfinished tail. */
  function takeLines(buf) {
    var parts = String(buf).split(/\r?\n/);
    return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] };
  }

  /** One streamed line: OpenRouter sends server-sent events ("data: {...}", ": comment", "data: [DONE]"), Ollama sends JSON lines. */
  function streamDelta(provider, line) {
    var s = String(line || "").trim();
    if (!s) return {};
    if (provider !== "local") {
      if (s.indexOf("data:") !== 0) return {}; // comments such as ": OPENROUTER PROCESSING", and event or id lines
      s = s.slice(5).trim();
      if (s === "[DONE]") return { done: true };
    }
    var j;
    try { j = JSON.parse(s); } catch (e) { return {}; }
    if (j && j.error) return { error: chatErrorDetail(j) || "The stream reported an error." };
    if (provider === "local") return { text: (j.message && typeof j.message.content === "string") ? j.message.content : "", done: !!j.done };
    var c = j.choices && j.choices[0];
    return { text: c && c.delta && typeof c.delta.content === "string" ? c.delta.content : "" };
  }

  /**
   * Send one chat request. Never rejects: resolves { ok, text, error, status }.
   * opts.onDelta(textSoFar) runs as streamed text arrives. A partial streamed answer is kept on error.
   */
  function sendChat(fetchFn, req, opts) {
    opts = opts || {};
    if (!req || !req.ok) return Promise.resolve({ ok: false, text: "", error: (req && req.error) || "Nothing to send." });
    if (typeof fetchFn !== "function") return Promise.resolve({ ok: false, text: "", error: "This browser cannot send requests (no fetch)." });
    var timeoutMs = opts.timeoutMs || CHAT_TIMEOUT_MS;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    function arm() { clearTimeout(timer); timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs); }
    var init = {};
    Object.keys(req.init).forEach(function (k) { init[k] = req.init[k]; });
    if (ctrl) init.signal = ctrl.signal;
    var acc = { text: "" };
    function delta(d) {
      if (d.text) { acc.text += d.text; if (opts.onDelta) opts.onDelta(acc.text); }
    }
    arm();
    var p;
    try { p = Promise.resolve(fetchFn(req.url, init)); } catch (e) { p = Promise.reject(e); }
    return p.then(function (res) {
      if (!res.ok) {
        var body = typeof res.json === "function" ? res.json().catch(function () { return null; }) : Promise.resolve(null);
        return body.then(function (j) { return { ok: false, status: res.status, text: "", error: httpErrorText(req.provider, res.status, chatErrorDetail(j)) }; });
      }
      if (req.stream) return readStream(res, req, delta, arm, acc);
      return res.json().then(function (j) {
        var detail = chatErrorDetail(j);
        if (detail) return { ok: false, status: res.status, text: "", error: (req.provider === "local" ? "Ollama" : "OpenRouter") + " reported an error: " + detail };
        var t = chatText(req.provider, j);
        if (t === null) return { ok: false, status: res.status, text: "", error: "The response did not contain an answer Model Scout can read." };
        if (!t.trim()) return { ok: false, status: res.status, text: "", error: "The model returned an empty answer." };
        return { ok: true, status: res.status, text: t, error: "" };
      }, function () {
        return { ok: false, status: res.status, text: "", error: "The response was not valid JSON." };
      });
    }).catch(function (e) {
      return { ok: false, text: acc.text, error: networkErrorText(req.provider, e, opts.pageUrl, timeoutMs) };
    }).then(function (r) { clearTimeout(timer); return r; });
  }

  /** Read a streamed body chunk by chunk. Falls back to reading it whole when the browser has no stream reader. */
  function readStream(res, req, delta, arm, acc) {
    var failed = "";
    function handle(lines) {
      for (var i = 0; i < lines.length && !failed; i++) {
        var d = streamDelta(req.provider, lines[i]);
        if (d.error) failed = d.error;
        else delta(d);
      }
    }
    function finish() {
      if (failed) return { ok: false, status: res.status, text: acc.text, error: "The model stopped with an error: " + failed };
      if (!acc.text.trim()) return { ok: false, status: res.status, text: "", error: "The model returned an empty answer." };
      return { ok: true, status: res.status, text: acc.text, error: "" };
    }
    var reader = res.body && typeof res.body.getReader === "function" && typeof TextDecoder === "function" ? res.body.getReader() : null;
    if (!reader) {
      return res.text().then(function (all) { handle(String(all).split(/\r?\n/)); return finish(); });
    }
    var dec = new TextDecoder(), buf = "";
    function pump() {
      return reader.read().then(function (r) {
        arm(); // each chunk restarts the idle timer
        if (r.done) { buf += dec.decode(); handle([buf]); return finish(); }
        var split = takeLines(buf + dec.decode(r.value, { stream: true }));
        buf = split.rest;
        handle(split.lines);
        if (failed) { try { reader.cancel(); } catch (e) { /* already closed */ } return finish(); }
        return pump();
      });
    }
    return pump();
  }

  /**
   * Side by side: fire every column at once. Each column settles on its own, so a failure (or a render
   * problem) in one never blocks the other. cols: [{ model, label, req }]. onUpdate(index, column) runs
   * on every status change. Resolves with the final columns.
   */
  function runCompare(fetchFn, cols, onUpdate, opts) {
    opts = opts || {};
    return Promise.all(cols.map(function (col, i) {
      var st = { model: col.model || "", label: col.label || "", status: "sending", text: "", error: "" };
      function update() { try { if (onUpdate) onUpdate(i, st); } catch (e) { /* keep the other column going */ } }
      if (!col.req || !col.req.ok) {
        st.status = "error";
        st.error = (col.req && col.req.error) || "No model chosen for this column.";
        update();
        return Promise.resolve(st);
      }
      update();
      return sendChat(fetchFn, col.req, { pageUrl: opts.pageUrl, timeoutMs: opts.timeoutMs, onDelta: function (t) { st.text = t; update(); } })
        .then(function (r) {
          st.status = r.ok ? "done" : "error";
          st.text = r.text || st.text;
          st.error = r.ok ? "" : r.error;
          update();
          return st;
        }, function (e) {
          st.status = "error";
          st.error = "Unexpected error: " + (e && e.message ? e.message : "unknown");
          update();
          return st;
        });
    }));
  }

  /** One side-by-side column: which side, the model name, its status, then the answer or the error. */
  function sideColumnHtml(side, col) {
    col = col || {};
    var st = SIDE_STATUS[col.status] || SIDE_STATUS.idle;
    var body;
    if (col.status === "error") {
      body = (col.text ? '<div class="msg-text">' + escapeHtml(col.text) + "</div>" : "") + '<p class="verdict warn">' + escapeHtml(col.error) + "</p>";
    } else if (col.text) {
      body = '<div class="msg-text">' + escapeHtml(col.text) + "</div>";
    } else if (col.status === "sending") {
      body = '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Waiting for ' + escapeHtml(col.label || "the model") + "...</p>";
    } else {
      body = '<p class="muted">The answer appears here.</p>';
    }
    return '<header class="side-head"><p class="eyebrow">' + escapeHtml(side) + "</p>" +
      '<h3 class="side-name">' + escapeHtml(col.label || "No model chosen") + "</h3>" +
      '<span class="badge ' + st.cls + '">' + st.text + "</span>" +
      (col.model ? '<p class="side-id">' + escapeHtml(col.model) + "</p>" : "") + "</header>" +
      '<div class="side-body">' + body + "</div>";
  }

  /** Where "Ask this model" goes: the chat model in single mode; in side by side, the first empty slot, else the left one. */
  function askTarget(mode, slots) {
    if (mode !== "side") return { target: "single" };
    var s = slots || [];
    return { target: "slot", index: !s[0] ? 0 : (!s[1] ? 1 : 0) };
  }

  // The key lives in the browser's localStorage only. These take the storage object so tests can stub it.
  function readKey(storage) {
    try { return (storage && storage.getItem(KEY_STORAGE)) || ""; } catch (e) { return ""; }
  }
  function saveKey(storage, key) {
    var k = String(key || "").trim();
    if (!k) return { ok: false, error: "Paste a key first." };
    if (/\s/.test(k)) return { ok: false, error: "That key contains spaces. Copy it again from openrouter.ai/keys." };
    try { storage.setItem(KEY_STORAGE, k); return { ok: true }; } catch (e) {
      return { ok: false, error: "This browser blocks local storage, so the key cannot be saved here. Allow site data for this page, or use Local Ollama." };
    }
  }
  function forgetKey(storage) {
    try { storage.removeItem(KEY_STORAGE); return true; } catch (e) { return false; }
  }

  var api = {
    STALE_AFTER_DAYS: STALE_AFTER_DAYS, REQUIRED_FIELDS: REQUIRED_FIELDS, SWITCH_MARGIN: SWITCH_MARGIN,
    monthlyCost: monthlyCost, blendedPrice: blendedPrice, staleStatus: staleStatus, validateEntry: validateEntry,
    dataFlags: dataFlags, computeWeights: computeWeights, scoreModel: scoreModel, rankModels: rankModels,
    switchCheck: switchCheck, mergeLive: mergeLive, suggestFromText: suggestFromText, costScoreFromPrice: costScoreFromPrice,
    fmtMoney: fmtMoney, fmtTokens: fmtTokens,
    CAPABILITIES: CAPABILITIES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, PRESETS: PRESETS,
    effectivePrices: effectivePrices, volumeFromRequests: volumeFromRequests, retirement: retirement, liveFacts: liveFacts, perMillion: perMillion,
    robustness: robustness, presetSettings: presetSettings, profileFromSettings: profileFromSettings,
    encodeSettings: encodeSettings, decodeSettings: decodeSettings,
    OPENROUTER_CHAT_URL: OPENROUTER_CHAT_URL, OLLAMA_CHAT_URL: OLLAMA_CHAT_URL, LOCAL_MODEL: LOCAL_MODEL,
    DEFAULT_CHAT_MODEL: DEFAULT_CHAT_MODEL, FEATURED_CHAT_MODELS: FEATURED_CHAT_MODELS, KEY_STORAGE: KEY_STORAGE,
    buildChatRequest: buildChatRequest, chatText: chatText, httpErrorText: httpErrorText, localModeCheck: localModeCheck,
    takeLines: takeLines, streamDelta: streamDelta, sendChat: sendChat, runCompare: runCompare,
    sideColumnHtml: sideColumnHtml, askTarget: askTarget, readKey: readKey, saveKey: saveKey, forgetKey: forgetKey
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // =====================================================================
  // Browser UI
  // =====================================================================
  var CARD_LIMIT = 6;
  var state = { catalog: null, catalogOrigin: "", base: [], liveOnly: [], live: null, liveIds: null, now: new Date(), lastOrder: null,
    touched: false, showAllCards: false, linkNote: "" };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeUrl(u) { return /^https:\/\//.test(String(u || "")) ? u : "#"; }

  var CHECK_IDS = { localOnly: "local-only", useBatch: "use-batch", tools: "need-tools", json: "need-json", reasoning: "need-reasoning" };
  var SELECT_IDS = { taskType: "task-type", modality: "modality", quality: "quality", latency: "latency", contextNeed: "context-need", cacheShare: "cache-share" };

  /** What the form shows, as settings (volumes in millions). */
  function readSettings() {
    var budgetRaw = $("budget").value.trim();
    var budget = budgetRaw === "" ? null : parseFloat(budgetRaw);
    function num(id) { var v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; }
    var s = {
      taskType: $("task-type").value, modality: $("modality").value, quality: $("quality").value, latency: $("latency").value,
      contextNeed: parseInt($("context-need").value, 10) || 0, budget: isFinite(budget) && budget > 0 ? budget : null,
      inputM: num("vol-in"), outputM: num("vol-out"), cacheShare: parseFloat($("cache-share").value) || 0
    };
    Object.keys(CHECK_IDS).forEach(function (k) { s[k] = $(CHECK_IDS[k]).checked; });
    return s;
  }

  /** Put settings into the form. Only the keys present change. */
  function applySettings(s) {
    Object.keys(SELECT_IDS).forEach(function (k) { if (k in s) $(SELECT_IDS[k]).value = String(s[k]); });
    Object.keys(CHECK_IDS).forEach(function (k) { if (k in s) $(CHECK_IDS[k]).checked = !!s[k]; });
    if ("budget" in s) $("budget").value = s.budget == null ? "" : String(s.budget);
    if ("inputM" in s) $("vol-in").value = String(s.inputM);
    if ("outputM" in s) $("vol-out").value = String(s.outputM);
  }

  function readProfile() {
    var p = profileFromSettings(readSettings());
    p.description = $("task-desc").value;
    return p;
  }

  function candidates() {
    return $("include-live").checked ? state.base.concat(state.liveOnly) : state.base;
  }

  function pct(x) { return Math.round(x * 100); }

  function bar(v) {
    return '<span class="bar" aria-hidden="true"><span style="width:' + pct(v) + '%"></span></span>';
  }

  function dataBadge(m) {
    var st = staleStatus(m, state.now);
    if (m.liveOnly) return '<span class="badge live">Live only</span>';
    if (m.price_status === "live") return '<span class="badge live">Live price</span>';
    if (st.stale) return '<span class="badge stale">Stale</span>';
    if (m.price_status === "unverified" || (m.unverified_fields && m.unverified_fields.length)) return '<span class="badge warn">Partly unverified</span>';
    if (m.price_status === "self-hosted") return '<span class="badge ok">Self-hosted</span>';
    return '<span class="badge ok">Verified ' + esc(String(m.last_verified).slice(0, 10)) + "</span>";
  }

  function renderWeights(w) {
    var html = Object.keys(w).map(function (k) {
      return '<li><span class="wname">' + COMPONENT_LABELS[k] + '</span>' + bar(w[k] / 0.5 > 1 ? 1 : w[k] / 0.5) +
        '<span class="wval">' + pct(w[k]) + "%</span></li>";
    }).join("");
    $("weights").innerHTML = html;
  }

  function costCell(r, p) {
    var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
    if (p.localOnly) return "Self-hosted<br><small>hosted reference " + esc(fmtMoney(mc)) + "</small>";
    return esc(fmtMoney(mc));
  }

  /** Which discounts the monthly figure includes, as a short note. */
  function costBasis(m, p) {
    var e = effectivePrices(m, p), bits = [];
    if (!e) return "";
    if (e.batch) bits.push("at batch prices");
    if (e.cache) bits.push("with " + Math.round(p.cacheShare * 100) + "% of input cached");
    return bits.length ? ", " + bits.join(", ") : "";
  }

  /** Large monthly cost readout for the top pick and the model cards. */
  function costFigure(r, p) {
    var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
    if (p.localOnly) {
      return '<span class="figure-value cost">Self-hosted<span class="unit">hosted reference ' + esc(fmtMoney(mc)) + " per month</span></span>";
    }
    return '<span class="figure-value cost">' + esc(fmtMoney(mc)) + '<span class="unit">per month at your volume' + esc(costBasis(r.model, p)) + "</span></span>";
  }

  /** Capabilities and limits from OpenRouter's list, as one sentence for a card. */
  function capsText(m) {
    if (m.kind === "embedding") return "";
    if (!m.capabilities) return "Capabilities: no data (not listed on OpenRouter).";
    var yes = CAPABILITIES.filter(function (k) { return m.capabilities[k]; }).map(function (k) { return CAPABILITY_LABELS[k]; });
    var no = CAPABILITIES.filter(function (k) { return !m.capabilities[k]; }).map(function (k) { return CAPABILITY_LABELS[k]; });
    var t = yes.length ? "Supports " + yes.join(", ") + "." : "Lists none of tool calling, JSON output, or reasoning mode.";
    if (yes.length && no.length) t += " Not listed: " + no.join(", ") + ".";
    if (isNum(m.max_output_tokens)) t += " Longest answer: " + fmtTokens(m.max_output_tokens) + " tokens.";
    return t;
  }

  /** Cache and batch prices, when listed. */
  function extraPricesText(m) {
    var bits = [];
    if (isNum(m.cache_read_price_per_mtok)) bits.push("cache read " + fmtPrice(m.cache_read_price_per_mtok) + " per 1M");
    if (isNum(m.batch_input_price_per_mtok)) bits.push("batch " + fmtPrice(m.batch_input_price_per_mtok) + " in / " + fmtPrice(m.batch_output_price_per_mtok) + " out per 1M");
    return bits.length ? "Other listed prices: " + bits.join("; ") + "." : "";
  }

  var CONFIDENCE_LABEL = { stable: "Stable pick", likely: "Likely pick", close: "Close call", tie: "Tie" };

  /** A share of reruns as a percentage that never rounds a rare win down to 0% or a near sweep up to 100%. */
  function fmtShare(x) {
    if (x >= 1) return "100%";
    if (x > 0.995) return "over 99%";
    if (x > 0 && x < 0.005) return "under 1%";
    return pct(x) + "%";
  }

  /** The robustness check under the top pick: a verdict, one sentence, and a bar of who wins how often. */
  function confidenceHtml(rb, top) {
    if (!rb) return "";
    var ru = rb.runnerUp, n = rb.samples, text;
    var rivals = rb.shares.filter(function (s) { return s.model.id !== top.model.id; });
    if (rb.verdict === "tie") {
      text = "Ties " + ru.model.model + " on every factor, so no weighting separates them. It is listed first only because it costs less per month, or sorts first by name.";
    } else {
      text = "Stays first in " + fmtShare(rb.topShare) + " of " + n + " reruns, with each factor's weight scaled at random between half and double.";
      if (rivals.length) text += " Most frequent rival: " + rivals[0].model.model + " (" + fmtShare(rivals[0].share) + ").";
      else text += " No rival comes first in any rerun.";
      if (ru && ru.dominated) text += " It matches or beats " + ru.model.model + " on every factor.";
    }
    var segs = rb.shares.slice(0, 5).map(function (s) {
      var me = s.model.id === top.model.id;
      return '<span class="conf-seg' + (me ? " is-top" : "") + '" style="flex-grow:' + Math.max(s.share, 0.01).toFixed(3) + '" title="' + esc(s.model.model + ": " + fmtShare(s.share)) + '"></span>';
    }).join("");
    var legend = rb.shares.slice(0, 3).map(function (s) {
      return "<li" + (s.model.id === top.model.id ? ' class="is-top"' : "") + "><span>" + esc(s.model.model) + "</span><span>" + fmtShare(s.share) + "</span></li>";
    }).join("");
    return '<div class="confidence" data-verdict="' + rb.verdict + '">' +
      '<p class="conf-head"><span class="figure-label">Confidence</span><span class="conf-verdict">' + CONFIDENCE_LABEL[rb.verdict] + "</span></p>" +
      (rb.verdict === "tie" ? "" : '<div class="conf-bar" aria-hidden="true">' + segs + "</div>" +
        '<ul class="conf-legend" aria-label="Share of reruns each model wins">' + legend + "</ul>") +
      '<p class="conf-text">' + esc(text) + "</p></div>";
  }

  var BEST_FLAG = '<span class="best-flag"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3 4 13.5l1-4.4-3.4-3 4.5-.5z"/></svg>Best pick</span>';
  var COLUMNS = ["Rank", "Model", "Score", "Cost", "Quality", "Speed", "Context fit", "Privacy", "Monthly cost", "Price in / out per 1M", "Context", "Data"];

  function flagList(items) {
    return items.length ? '<ul class="flags">' + items.join("") + "</ul>" : "";
  }

  /** Inline errors next to the number fields. Values are still read the same way by readProfile. */
  function validateFields() {
    [["budget", "Enter a price of 0 or more, or leave it empty for no limit. Until then there is no budget limit."],
     ["vol-in", "Enter 0 or more million tokens. Until then input volume counts as 0."],
     ["vol-out", "Enter 0 or more million tokens. Until then output volume counts as 0."]].forEach(function (f) {
      var el = $(f[0]), msg = $(f[0] + "-error");
      if (!el || !msg) return;
      var raw = el.value.trim();
      var bad = (el.validity && el.validity.badInput) || (raw !== "" && (!isFinite(parseFloat(raw)) || parseFloat(raw) < 0));
      if (bad) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
      if (msg.textContent !== (bad ? f[1] : "")) msg.textContent = bad ? f[1] : "";
    });
  }

  function render() {
    if (!state.base.length) return;
    validateFields();
    var p = readProfile();
    var res = rankModels(candidates(), p, state.now);
    renderWeights(res.weights);
    var top = res.ranked[0];

    // The reveal animation plays only when the ranking order changes, not on every keystroke.
    var order = res.ranked.map(function (r) { return r.model.id; }).join("|");
    var reveal = order !== state.lastOrder;
    state.lastOrder = order;

    // headline
    var head = $("top-pick");
    head.setAttribute("aria-busy", "false");
    head.classList.toggle("is-reveal", reveal);
    head.classList.toggle("is-empty", !top);
    if (!top) {
      head.innerHTML = '<p class="eyebrow">No result for this profile</p>' +
        '<h3>No model fits every hard constraint</h3><p>Every candidate was excluded. See the excluded list below and loosen a constraint (for example turn off local-only or change the modality).</p>';
    } else {
      var tf = dataFlags(top.model, state.now);
      head.innerHTML = BEST_FLAG +
        '<p class="eyebrow">Top pick for this profile</p>' +
        "<h3>" + esc(top.model.model) + ' <span class="provider">' + esc(top.model.provider) + "</span></h3>" +
        '<div class="figures">' +
          '<p class="score-big"><span class="figure-label">Score</span><span class="figure-value score">' + top.total + " <small>of 100</small></span></p>" +
          '<p><span class="figure-label">Estimated monthly cost</span>' + costFigure(top, p) + "</p>" +
        "</div>" +
        '<p class="reason"><strong>Why:</strong> ' + esc(top.explain.why) + "</p>" +
        '<p class="reason"><strong>What you trade away:</strong> ' + esc(top.explain.tradeoffs) + "</p>" +
        confidenceHtml(robustness(res), top) +
        flagList(tf.map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; })) +
        flagList(top.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }));
    }

    // table: every cell carries its column name so narrow screens can stack rows as labelled cards
    function td(i, cls, html) { return '<td class="' + cls + '" data-label="' + esc(COLUMNS[i]) + '">' + html + "</td>"; }
    var rows = res.ranked.map(function (r) {
      var c = r.components, m = r.model;
      return '<tr class="' + (r.rank === 1 ? "is-top" : "") + '">' +
        td(0, "rank-cell", "#" + r.rank) +
        '<th scope="row"><a href="#card-' + esc(m.id) + '">' + esc(m.model) + "</a><br><small>" + esc(m.provider) + "</small>" +
          (r.rank === 1 ? '<span class="pick-tag">Best pick</span>' : "") + "</th>" +
        td(2, "num score-cell", "<strong>" + r.total + "</strong>") +
        ["cost", "quality", "latency", "context", "privacy"].map(function (k, i) { return td(3 + i, "num", String(pct(c[k]))); }).join("") +
        td(8, "num money", costCell(r, p)) +
        td(9, "num", fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok)) +
        td(10, "num", esc(fmtTokens(m.context_window)) + (m.unverified_fields && m.unverified_fields.indexOf("context_window") >= 0 ? "*" : "")) +
        td(11, "wide-cell", dataBadge(m)) + "</tr>";
    }).join("");
    $("compare-body").innerHTML = rows || '<tr class="empty-row"><td colspan="12">No candidates. Every model was excluded by a hard constraint.</td></tr>';
    $("result-count").textContent = res.ranked.length + " ranked, " + res.excluded.length + " excluded by hard constraints.";

    // cards
    var cards = $("cards");
    cards.classList.toggle("is-reveal", reveal);
    cards.innerHTML = res.ranked.length ? res.ranked.map(function (r, idx) {
      var m = r.model, c = r.components;
      var flags = dataFlags(m, state.now).map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; })
        .concat(r.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }))
        .concat(r.notes.map(function (f) { return '<li class="info">' + esc(f) + "</li>"; }));
      if (m.live && m.live.changes.length) flags.push('<li class="info">Live data changed: ' + esc(m.live.changes.join("; ")) + ".</li>");
      return '<article class="card' + (r.rank === 1 ? " is-top" : "") + '" id="card-' + esc(m.id) + '" style="--i:' + Math.min(idx, 8) + '">' +
        (r.rank === 1 ? BEST_FLAG : "") +
        '<header class="card-head"><span class="rank">#' + r.rank + "</span>" +
          "<div><h3>" + esc(m.model) + '</h3><span class="provider">' + esc(m.provider) + "</span></div>" +
          '<span class="card-score">' + r.total + "<small>of 100</small></span></header>" +
        '<div class="card-cost"><span class="figure-label">Monthly</span>' + costFigure(r, p) + "</div>" +
        '<dl class="breakdown">' + ["cost", "quality", "latency", "context", "privacy"].map(function (k) {
          return "<dt>" + COMPONENT_LABELS[k] + "</dt><dd>" + bar(c[k]) + " " + pct(c[k]) + "</dd>";
        }).join("") + "</dl>" +
        '<p class="reason"><strong>Why this model:</strong> ' + esc(r.explain.why) + "</p>" +
        '<p class="reason"><strong>Trade-offs:</strong> ' + esc(r.explain.tradeoffs) + "</p>" +
        '<p class="facts">' + "Price in/out per 1M tokens: " + fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok) +
        ". Context: " + esc(fmtTokens(m.context_window)) + ". Speed: " + esc(m.latency_class || "not rated") +
        ". Quality tier: " + (m.quality_tier != null ? m.quality_tier + " of 5 (editorial)" : "not rated") +
        ". Open weights: " + (m.open_weights ? "yes" : "no") + ". Monthly: " + costCell(r, p) + ".</p>" +
        (capsText(m) ? '<p class="facts">' + esc(capsText(m)) + "</p>" : "") +
        (extraPricesText(m) ? '<p class="facts">' + esc(extraPricesText(m)) + "</p>" : "") +
        (m.strengths.length ? '<p class="facts"><strong>Strengths:</strong> ' + esc(m.strengths.join("; ")) + ".</p>" : "") +
        (m.limits.length ? '<p class="facts"><strong>Limits:</strong> ' + esc(m.limits.join("; ")) + ".</p>" : "") +
        flagList(flags) +
        '<p class="source">Source: <a href="' + esc(safeUrl(m.source.url)) + '" rel="noopener">' + esc(m.source.name) + "</a>. " + dataBadge(m) + "</p>" +
        askButton(m) +
        "</article>";
    }).join("") : '<p class="cards-empty">No model cards to show: every candidate failed a hard constraint. Loosen one in the profile above.</p>';
    applyCardLimit();

    // excluded
    $("excluded").innerHTML = res.excluded.length ? res.excluded.map(function (r) {
      return "<li><strong>" + esc(r.model.model) + "</strong> (" + esc(r.model.provider) + "): " + esc(r.excludeReason) + "</li>";
    }).join("") : "<li>None. Every model passed the hard constraints.</li>";

    renderSwitchOptions();
    renderSwitch();
    syncUrl();
  }

  /** Only the first CARD_LIMIT cards show until the reader asks for all of them. */
  function applyCardLimit() {
    var list = $("cards").querySelectorAll(".card"), btn = $("cards-toggle"), extra = list.length - CARD_LIMIT;
    Array.prototype.forEach.call(list, function (c, i) { c.hidden = !state.showAllCards && i >= CARD_LIMIT; });
    btn.hidden = extra <= 0;
    btn.setAttribute("aria-expanded", state.showAllCards ? "true" : "false");
    btn.textContent = state.showAllCards ? "Show only the top " + CARD_LIMIT : "Show all " + list.length + " model cards";
    $("cards-lede").textContent = extra > 0 && !state.showAllCards ?
      "The top " + CARD_LIMIT + " of " + list.length + " ranked models, with their reasons, trade-offs, capabilities, source, and data status. Every model is in the table above." :
      "Every ranked model, with its reasons, trade-offs, capabilities, source, and data status.";
  }

  /** Keep the page address in step with the settings once the reader has changed something, so it can be shared. */
  function syncUrl() {
    if (!state.touched || !window.history || typeof history.replaceState !== "function") return;
    var qs = encodeSettings(readSettings());
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch (e) { /* file:// in some browsers */ }
  }

  function shareUrl() {
    var qs = encodeSettings(readSettings());
    return location.href.split(/[?#]/)[0] + (qs ? "?" + qs : "") + "#results";
  }

  function copyShareLink() {
    var url = shareUrl(), out = $("share-status");
    function done(ok) {
      out.textContent = ok ? "Link copied. It holds your settings, not your description." : "Copy this link by hand: " + url;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  }

  // ----- presets and the volume helper -----
  function renderPresets() {
    $("preset-list").innerHTML = PRESETS.map(function (pr) {
      return '<button type="button" class="preset" data-preset="' + esc(pr.id) + '" aria-pressed="false">' + esc(pr.name) + "</button>";
    }).join("");
    $("presets").hidden = false;
  }

  function markPreset(id) {
    Array.prototype.forEach.call($("preset-list").querySelectorAll(".preset"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-preset") === id ? "true" : "false");
    });
  }

  function usePreset(id) {
    var s = presetSettings(id), pr = PRESETS.filter(function (x) { return x.id === id; })[0];
    if (!s || !pr) return;
    applySettings(s);
    $("task-desc").value = pr.description;
    markPreset(id);
    $("preset-result").textContent = "Loaded " + pr.name + ": every field below now matches that case. Volumes are examples, so set your own.";
    $("suggest-result").textContent = "";
    state.touched = true;
    render();
  }

  function helperVolume() {
    function v(id) { var x = parseFloat($(id).value); return isFinite(x) && x > 0 ? x : 0; }
    var d = v("req-day"), i = v("req-in"), o = v("req-out");
    return { ready: d > 0 && (i > 0 || o > 0), vol: volumeFromRequests(d, i, o) };
  }

  function fmtMillions(x) { return String(x >= 100 ? Math.round(x) : x >= 1 ? round(x, 2) : Math.max(round(x, 4), x > 0 ? 0.0001 : 0)); }

  function renderHelper() {
    var h = helperVolume(), out = $("req-readout");
    $("req-apply").disabled = !h.ready;
    out.textContent = !h.ready ? "Fill in the three numbers to see the monthly volume." :
      "About " + Math.round(h.vol.requests).toLocaleString("en-US") + " requests a month: " + fmtMillions(h.vol.inputM) +
      " million input and " + fmtMillions(h.vol.outputM) + " million output tokens.";
  }

  function applyHelper() {
    var h = helperVolume();
    if (!h.ready) return;
    applySettings({ inputM: Number(fmtMillions(h.vol.inputM)), outputM: Number(fmtMillions(h.vol.outputM)) });
    $("req-readout").textContent += " Copied into the volume fields.";
    state.touched = true;
    render();
  }

  function renderSwitchOptions() {
    var sel = $("current-model"), prev = sel.value;
    var list = candidates().slice().sort(function (a, b) { return a.model.localeCompare(b.model); });
    if (sel.options.length === list.length + 1 && sel.dataset.n === String(list.length)) return;
    sel.innerHTML = '<option value="">Choose your current model</option>' + list.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.model) + " (" + esc(m.provider) + ")</option>";
    }).join("");
    sel.dataset.n = String(list.length);
    sel.value = prev;
  }

  function renderSwitch() {
    var id = $("current-model").value, out = $("switch-result");
    if (!id) { out.innerHTML = "<p>Pick the model you use today. The check uses the profile and weights you set above.</p>"; return; }
    var r = switchCheck(candidates(), id, readProfile(), state.now);
    if (r.excluded) { out.innerHTML = '<p class="verdict warn">Your current model fails a hard constraint in this profile: ' + esc(r.excludeReason) + " Reconsider it now.</p>"; return; }
    if (!r.found) { out.innerHTML = "<p>That model is not in the current candidate list.</p>"; return; }
    var cur = r.current, html = "";
    html += "<p>" + esc(cur.model.model) + " scores <strong>" + cur.total + "</strong> and ranks #" + cur.rank + " under your weights.</p>";
    if (!r.better.length) html += '<p class="verdict ok">No catalog model beats it on your weights. Keep it, and re-run this check when prices or your needs change.</p>';
    else {
      html += '<p class="verdict ' + (r.worthSwitching ? "warn" : "ok") + '">' + r.better.length + " model" + (r.better.length > 1 ? "s beat" : " beats") + " it. " +
        (r.worthSwitching ? "The best challenger wins by " + r.better[0].margin + " points, at or above the " + SWITCH_MARGIN + " point switch threshold: worth a trial." :
          "The best challenger wins by only " + r.better[0].margin + " points, under the " + SWITCH_MARGIN + " point threshold: not worth a migration on score alone.") + "</p>";
      html += "<ol>" + r.better.slice(0, 5).map(function (b) {
        return "<li>" + esc(b.model.model) + " (" + esc(b.model.provider) + "): +" + b.margin + " points</li>";
      }).join("") + "</ol>";
    }
    if (r.stale && r.stale.stale) html += '<p class="verdict warn">Spec warning: ' + esc(r.stale.reason) + " Re-check its pricing page before trusting this comparison.</p>";
    if (r.retirement) html += '<p class="verdict warn">' + esc(r.retirement.text) + "</p>";
    out.innerHTML = html;
  }

  function renderStatus() {
    var c = state.catalog, st = staleStatus({ last_verified: c.catalog_date }, state.now, c.stale_after_days);
    var html = '<p><strong>Bundled catalog dated ' + esc(c.catalog_date) + "</strong> (" + state.base.length + " models, " +
      (st.ageDays != null ? st.ageDays + (st.ageDays === 1 ? " day old" : " days old") : "age unknown") + ", loaded from " + esc(state.catalogOrigin) + "). ";
    if (st.stale) html += '<span class="badge stale">Stale</span> This catalog is older than ' + c.stale_after_days + " days. Treat prices as possibly out of date. ";
    html += "</p>";
    var L = state.live;
    if (!L) html += '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Checking OpenRouter for live prices...</p>';
    else if (L.ok) {
      html += '<p><span class="badge live">Live</span> OpenRouter model list fetched ' + esc(L.fetchedAt.toLocaleString()) +
        ": " + L.matched + " catalog models updated with live prices" + (L.changed.length ? " (" + L.changed.length + " changed since the bundled snapshot)" : ", none changed since the bundled snapshot") +
        ". " + L.liveOnly + " other live models are available with the checkbox above the results.</p>";
    } else {
      html += '<p><span class="badge warn">Offline</span> Live data unavailable (' + esc(L.error) + "). Using the bundled catalog dated " + esc(c.catalog_date) + ".</p>";
    }
    var box = $("data-status");
    box.innerHTML = html;
    box.setAttribute("data-state", !L ? "loading" : !L.ok ? "offline" : st.stale ? "stale" : "live");
    $("include-live").disabled = !(L && L.ok);
    $("include-live-help").textContent = !L ? "Turns on once the live OpenRouter list has loaded." :
      L.ok ? L.liveOnly + " unreviewed live models are available." : "Unavailable: live data could not be loaded.";
  }

  function applySuggestions() {
    var s = suggestFromText($("task-desc").value);
    var out = $("suggest-result");
    if (!s.why.length) { out.textContent = "No keywords matched. Set the fields below by hand."; return; }
    applySettings(s.settings);
    markPreset("");
    out.textContent = "Updated settings because your description " + s.why.join(", ") + ". This is simple keyword matching: check the fields.";
    state.touched = true;
    render();
  }

  function loadCatalog() {
    function fromEmbedded(why) {
      var el = $("embedded-catalog");
      state.catalogOrigin = "the copy embedded in index.html (" + why + ")";
      return JSON.parse(el.textContent);
    }
    if (typeof fetch !== "function" || location.protocol === "file:") {
      return Promise.resolve(fromEmbedded(location.protocol === "file:" ? "opened as a local file" : "fetch unavailable"));
    }
    return fetch("catalog.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) { state.catalogOrigin = "catalog.json"; return j; })
      .catch(function (e) { return fromEmbedded("catalog.json failed: " + e.message); });
  }

  function loadLive() {
    if (typeof fetch !== "function") { state.live = { ok: false, error: "this browser cannot fetch" }; return Promise.resolve(); }
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    return fetch(OPENROUTER_URL, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !Array.isArray(j.data)) throw new Error("unexpected response format");
      var at = new Date();
      state.liveIds = {};
      j.data.forEach(function (x) { if (x && x.id) state.liveIds[x.id] = true; });
      var m = mergeLive(state.catalog.models, j.data, at);
      state.base = m.models;
      state.liveOnly = m.liveOnly;
      state.live = { ok: true, fetchedAt: at, matched: m.matched, changed: m.changed, liveOnly: m.liveOnly.length };
    }).catch(function (e) {
      state.live = { ok: false, error: e && e.name === "AbortError" ? "timed out" : "blocked, offline, or failed: " + (e && e.message ? e.message : "unknown error") };
    }).then(function () { clearTimeout(timer); });
  }

  // ---------- Ask a model: chat panel, key box, side by side ----------
  // chat.side holds the last state of each side-by-side column (null = follow the picker).
  var chat = { entries: [], busy: false, sideBusy: false, extra: [], side: [null, null] };

  function keyStorage() { try { return window.localStorage; } catch (e) { return null; } }
  function chatFetch(url, init) { return fetch(url, init); }
  function chatProvider() { return $("chat-provider-local").checked ? "local" : "openrouter"; }
  function chatMode() { return $("chat-mode-side").checked ? "side" : "single"; }

  /** The button at the foot of every model card. Models that cannot chat get a disabled button and the reason. */
  function askButton(m) {
    if (m.kind === "embedding" || !m.openrouter_id) {
      var nid = "ask-note-" + m.id;
      return '<div class="card-actions"><button type="button" class="btn ask-btn" disabled aria-describedby="' + esc(nid) + '">Ask this model</button>' +
        '<small id="' + esc(nid) + '">' + (m.kind === "embedding" ? "Embedding models make search vectors and cannot chat." :
          "Not listed on OpenRouter, so it cannot be asked from here.") + "</small></div>";
    }
    return '<div class="card-actions"><button type="button" class="btn ask-btn" data-ask="' + esc(m.openrouter_id) + '" data-name="' + esc(m.model) + '">' +
      'Ask this model<span class="visually-hidden">: ' + esc(m.model) + "</span></button></div>";
  }

  /** Every model the chat can name: featured, catalog (with live prices once loaded), live-only, and models added from cards. */
  function chatPool() { return state.base.concat(state.liveOnly).concat(chat.extra); }

  function chatModelLabel(id) {
    if (!id) return "";
    var i, pool = chatPool();
    for (i = 0; i < FEATURED_CHAT_MODELS.length; i++) if (FEATURED_CHAT_MODELS[i].id === id) return FEATURED_CHAT_MODELS[i].name;
    for (i = 0; i < pool.length; i++) if (pool[i].openrouter_id === id) return pool[i].model;
    return id;
  }

  function chatOptionsHtml(withEmpty) {
    var live = state.liveIds, seen = {};
    function opt(id, label) {
      seen[id] = true;
      var missing = live && !live[id] ? " (not in OpenRouter's live list today)" : "";
      return '<option value="' + esc(id) + '">' + esc(label + missing) + "</option>";
    }
    var html = withEmpty ? '<option value="">Choose a model</option>' : "";
    html += '<optgroup label="Suggested for chat">' + FEATURED_CHAT_MODELS.map(function (f) { return opt(f.id, f.name); }).join("") + "</optgroup>";
    var cat = state.base.filter(function (m) { return m.kind === "generation" && m.openrouter_id && !seen[m.openrouter_id]; })
      .sort(function (a, b) { return a.model.localeCompare(b.model); });
    if (cat.length) {
      html += '<optgroup label="From the Model Scout catalog">' + cat.map(function (m) { return opt(m.openrouter_id, m.model + " (" + m.provider + ")"); }).join("") + "</optgroup>";
    }
    var extra = chat.extra.filter(function (m) { return !seen[m.openrouter_id]; });
    if (extra.length) {
      html += '<optgroup label="Added from model cards">' + extra.map(function (m) { return opt(m.openrouter_id, m.model); }).join("") + "</optgroup>";
    }
    return html;
  }

  function refill(sel, withEmpty, fallback) {
    var prev = sel.value;
    sel.innerHTML = chatOptionsHtml(withEmpty);
    sel.value = prev;
    if (sel.value !== prev) sel.value = fallback;
  }

  function fillChatPickers() {
    refill($("chat-model"), false, DEFAULT_CHAT_MODEL);
    refill($("side-model-a"), true, "");
    refill($("side-model-b"), true, "");
    renderModelNote();
    renderSideIdle();
  }

  function renderModelNote() {
    var note = $("chat-model-note");
    if (chatProvider() === "local") { note.textContent = "Local mode always uses dolphin3 in Ollama. This picker applies to OpenRouter."; return; }
    var id = $("chat-model").value, text = "OpenRouter model id: " + id + ".", pool = chatPool();
    for (var i = 0; i < pool.length; i++) {
      var m = pool[i];
      if (m.openrouter_id === id && m.price_status === "live") {
        text += " Live price: " + fmtPrice(m.input_price_per_mtok) + " in / " + fmtPrice(m.output_price_per_mtok) + " out per 1M tokens.";
        break;
      }
    }
    if (state.liveIds && !state.liveIds[id]) text += " Not in OpenRouter's live model list today, so the request may fail.";
    note.textContent = text;
  }

  function chatNote(text, level) {
    var el = $("chat-status");
    el.textContent = text || "";
    if (level) el.setAttribute("data-level", level); else el.removeAttribute("data-level");
  }

  // ----- provider and mode -----
  function applyProvider() {
    var local = chatProvider() === "local";
    $("chat-key-box").hidden = local;
    $("chat-local-note").hidden = !local;
    $("chat-model").disabled = local;
    $("side-model-a").disabled = local;
    $("side-model-b").disabled = local;
    var check = localModeCheck(location.href), lc = $("chat-local-check");
    lc.textContent = check.text;
    lc.className = "verdict " + (check.ok ? "ok" : "warn");
    chat.side = chat.side.map(function (c) { return c && c.status === "idle" ? null : c; });
    renderModelNote();
    renderSideIdle();
  }

  function applyMode() {
    var side = chatMode() === "side";
    $("chat-single").hidden = side;
    $("chat-side").hidden = !side;
    chatNote("");
  }

  // ----- key box: localStorage only -----
  function renderKeyStatus() {
    var store = keyStorage(), k = readKey(store);
    $("chat-key-status").textContent = !store ? "This browser blocks local storage, so a key cannot be saved here. Local Ollama still works." :
      k ? "A key is saved in this browser, ending in " + k.slice(-4) + ". Paste a new key to replace it." : "No key saved yet.";
    $("chat-key-forget").disabled = !k;
  }

  function keyError(text) {
    $("chat-key-error").textContent = text || "";
    if (text) $("chat-key").setAttribute("aria-invalid", "true"); else $("chat-key").removeAttribute("aria-invalid");
  }

  function promptForKey() {
    keyError("Add your OpenRouter key to send: paste it here and press Save key. Or switch the provider to Local Ollama.");
    chatNote("No OpenRouter key saved yet. Add one in the key box.", "warn");
    $("chat-key").focus();
  }

  function saveKeyFromForm() {
    var store = keyStorage();
    var r = store ? saveKey(store, $("chat-key").value) : { ok: false, error: "This browser blocks local storage, so the key cannot be saved here." };
    if (!r.ok) { keyError(r.error); return; }
    $("chat-key").value = "";
    keyError("");
    renderKeyStatus();
    chatNote("Key saved in this browser only.", "ok");
  }

  function forgetKeyClick() {
    forgetKey(keyStorage());
    $("chat-key").value = "";
    keyError("");
    renderKeyStatus();
    chatNote("Key removed from this browser.", "ok");
  }

  // ----- single model chat -----
  function renderChatLog() {
    var log = $("chat-log");
    if (!chat.entries.length) {
      log.innerHTML = '<p class="chat-empty">No messages yet. Pick a model, type a question, and press Send. The conversation stays in this page and is gone when you reload.</p>';
      return;
    }
    log.innerHTML = chat.entries.map(function (e) {
      if (e.role === "user") return '<div class="msg msg-user"><p class="msg-who">You</p><div class="msg-text">' + esc(e.content) + "</div></div>";
      var who = '<p class="msg-who">' + esc(e.label) + "</p>";
      var text = e.content ? '<div class="msg-text">' + esc(e.content) + "</div>" : "";
      if (e.role === "pending") return '<div class="msg msg-model">' + who + (text || '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Waiting for the answer...</p>') + "</div>";
      if (e.role === "error") return '<div class="msg msg-model msg-error">' + who + text + '<p class="verdict warn">' + esc(e.error) + "</p></div>";
      return '<div class="msg msg-model">' + who + text + "</div>";
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  function setChatBusy(b) {
    chat.busy = b;
    $("chat-send").disabled = b;
    $("chat-send").textContent = b ? "Sending..." : "Send";
    $("chat-clear").disabled = b;
    $("chat-log").setAttribute("aria-busy", b ? "true" : "false");
  }

  /** What the API sees: user and assistant turns only, never error notes or pending placeholders. */
  function chatHistory() {
    return chat.entries.filter(function (e) { return e.role === "user" || e.role === "assistant"; })
      .map(function (e) { return { role: e.role, content: e.content }; });
  }

  function chatSend() {
    if (chat.busy) return;
    var text = $("chat-input").value.trim();
    if (!text) { chatNote("Type a message first.", "warn"); $("chat-input").focus(); return; }
    var provider = chatProvider(), key = "";
    if (provider === "openrouter") {
      key = readKey(keyStorage());
      if (!key) { promptForKey(); return; }
    }
    var model = provider === "local" ? LOCAL_MODEL : $("chat-model").value;
    var label = provider === "local" ? LOCAL_LABEL : chatModelLabel(model);
    chat.entries.push({ role: "user", content: text });
    var req = buildChatRequest(provider, model, chatHistory(), key, $("chat-stream").checked);
    var pending = { role: "pending", label: label, content: "", error: "" };
    chat.entries.push(pending);
    $("chat-input").value = "";
    chatNote("Sending to " + label + "...");
    setChatBusy(true);
    renderChatLog();
    sendChat(chatFetch, req, { pageUrl: location.href, onDelta: function (t) { pending.content = t; renderChatLog(); } }).then(function (r) {
      pending.role = r.ok ? "assistant" : "error";
      pending.content = r.text || "";
      pending.error = r.ok ? "" : r.error;
      setChatBusy(false);
      renderChatLog();
      chatNote(r.ok ? "Answer from " + label + "." : "The request failed: see the message in the conversation.", r.ok ? "" : "warn");
    });
  }

  // ----- side by side -----
  function sideColumnFor(i) {
    if (chatProvider() === "local") return { model: LOCAL_MODEL, label: LOCAL_LABEL };
    var id = i ? $("side-model-b").value : $("side-model-a").value;
    return { model: id, label: chatModelLabel(id) };
  }

  function renderSideCol(i, st) {
    var el = i ? $("side-col-b") : $("side-col-a");
    chat.side[i] = st;
    el.setAttribute("data-status", st.status || "idle");
    el.setAttribute("aria-busy", st.status === "sending" ? "true" : "false");
    el.innerHTML = sideColumnHtml(i ? "Right" : "Left", st);
  }

  /** Columns that are not showing an answer follow their picker. */
  function renderSideIdle() {
    [0, 1].forEach(function (i) {
      var cur = chat.side[i];
      if (cur && cur.status !== "idle") return;
      var c = sideColumnFor(i);
      renderSideCol(i, { status: "idle", model: c.model, label: c.label, text: "", error: "" });
    });
  }

  function setSideBusy(b) {
    chat.sideBusy = b;
    $("side-send").disabled = b;
    $("side-send").textContent = b ? "Sending..." : "Send to both";
  }

  function sideSend() {
    if (chat.sideBusy) return;
    var q = $("side-input").value.trim();
    if (!q) { chatNote("Type a question first.", "warn"); $("side-input").focus(); return; }
    var provider = chatProvider(), key = "";
    var ids = [$("side-model-a").value, $("side-model-b").value];
    if (provider === "openrouter") {
      if (!ids[0] && !ids[1]) { chatNote("Choose a model for at least one column.", "warn"); $("side-model-a").focus(); return; }
      key = readKey(keyStorage());
      if (!key) { promptForKey(); return; }
    }
    var msgs = [{ role: "user", content: q }], stream = $("chat-stream").checked;
    var cols = [0, 1].map(function (i) {
      var c = sideColumnFor(i);
      if (!c.model) return { model: "", label: "", req: null };
      return { model: c.model, label: c.label, req: buildChatRequest(provider, c.model, msgs, key, stream) };
    });
    setSideBusy(true);
    chatNote("Sending to both columns...");
    runCompare(chatFetch, cols, renderSideCol, { pageUrl: location.href }).then(function (res) {
      setSideBusy(false);
      var fails = res.filter(function (c) { return c.status === "error"; }).length;
      chatNote(fails === 0 ? "Both answers are in." : fails === 1 ? "One column failed; the other answer is shown." : "Both columns failed: see each column for the reason.", fails ? "warn" : "");
    });
  }

  // ----- "Ask this model" on the cards -----
  function askFromCard(btn) {
    var id = btn.getAttribute("data-ask"), name = btn.getAttribute("data-name") || id;
    if (!id) return;
    var listed = Array.prototype.some.call($("chat-model").options, function (o) { return o.value === id; });
    if (!listed) { chat.extra.push({ openrouter_id: id, model: name }); fillChatPickers(); }
    var note = "";
    if (chatProvider() === "local") {
      $("chat-provider-openrouter").checked = true;
      applyProvider();
      note = " Switched the provider to OpenRouter, because local mode only runs dolphin3.";
    }
    var t = askTarget(chatMode(), [$("side-model-a").value, $("side-model-b").value]), target;
    if (t.target === "single") {
      $("chat-model").value = id;
      renderModelNote();
      chatNote("Chat model set to " + name + "." + note + " Type your question below.", "ok");
      target = $("chat-input");
    } else {
      (t.index ? $("side-model-b") : $("side-model-a")).value = id;
      chat.side[t.index] = null;
      renderSideIdle();
      chatNote((t.index ? "Right" : "Left") + " column set to " + name + "." + note, "ok");
      target = $("side-input");
    }
    // Bring the chat panel to the top, then let focus scroll the input into view if it is still below the fold (phones).
    var panel = $("chat-main");
    if (panel.scrollIntoView) panel.scrollIntoView({ block: "start" });
    target.focus();
  }

  function initChat() {
    $("chat-provider-openrouter").addEventListener("change", applyProvider);
    $("chat-provider-local").addEventListener("change", applyProvider);
    $("chat-mode-single").addEventListener("change", applyMode);
    $("chat-mode-side").addEventListener("change", applyMode);
    $("chat-key-form").addEventListener("submit", function (e) { e.preventDefault(); saveKeyFromForm(); });
    $("chat-key-forget").addEventListener("click", forgetKeyClick);
    $("chat-key").addEventListener("input", function () { keyError(""); });
    $("chat-model").addEventListener("change", renderModelNote);
    $("side-model-a").addEventListener("change", function () { chat.side[0] = null; renderSideIdle(); });
    $("side-model-b").addEventListener("change", function () { chat.side[1] = null; renderSideIdle(); });
    $("chat-form").addEventListener("submit", function (e) { e.preventDefault(); chatSend(); });
    $("side-form").addEventListener("submit", function (e) { e.preventDefault(); sideSend(); });
    // Enter sends, Shift+Enter adds a line (and never while an input method is composing text).
    $("chat-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); }
    });
    $("side-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sideSend(); }
    });
    $("chat-clear").addEventListener("click", function () {
      if (chat.busy) return;
      chat.entries = [];
      renderChatLog();
      chatNote("Conversation cleared.");
      $("chat-input").focus();
    });
    $("cards").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".ask-btn") : null;
      if (b && !b.disabled) askFromCard(b);
    });
    fillChatPickers();
    applyProvider();
    applyMode();
    renderKeyStatus();
    renderChatLog();
  }

  /** Settings from the page address (a shared link). Unknown or invalid ones are skipped and reported. */
  function settingsFromUrl() {
    var d = decodeSettings(location.search);
    if (Object.keys(d.settings).length) applySettings(d.settings);
    if (d.ignored.length) $("share-status").textContent = "This link had settings Model Scout could not read, so they were skipped: " + d.ignored.join(", ") + ".";
    else if (Object.keys(d.settings).length) $("share-status").textContent = "Settings loaded from the link.";
  }

  function init() {
    var form = $("profile");
    function edited(e) {
      var id = e && e.target && e.target.id;
      if (id && /^req-/.test(id)) { renderHelper(); return; } // the volume helper only fills the fields when asked
      state.touched = true;
      if (e && e.type === "input" && id !== "task-desc") markPreset("");
      render();
    }
    form.addEventListener("input", edited);
    form.addEventListener("change", edited);
    form.addEventListener("submit", function (e) { e.preventDefault(); render(); });
    $("suggest").addEventListener("click", applySuggestions);
    $("include-live").addEventListener("change", render);
    $("current-model").addEventListener("change", renderSwitch);
    $("preset-list").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".preset") : null;
      if (b) usePreset(b.getAttribute("data-preset"));
    });
    $("req-apply").addEventListener("click", applyHelper);
    $("share-link").addEventListener("click", copyShareLink);
    $("cards-toggle").addEventListener("click", function () {
      state.showAllCards = !state.showAllCards;
      applyCardLimit();
      if (!state.showAllCards) $("cards-toggle").scrollIntoView({ block: "nearest" });
    });
    // A table link to a card that is folded away opens every card first, so the jump lands.
    $("compare-body").addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#card-"]') : null;
      if (!a) return;
      var card = document.getElementById(a.getAttribute("href").slice(1));
      if (card && card.hidden) { state.showAllCards = true; applyCardLimit(); }
    });
    renderPresets();
    renderHelper();
    settingsFromUrl();
    initChat();
    loadCatalog().then(function (cat) {
      state.catalog = cat;
      state.base = cat.models.slice();
      $("catalog-date").textContent = cat.catalog_date;
      $("stale-days").textContent = String(cat.stale_after_days || STALE_AFTER_DAYS);
      renderStatus();
      render();
      fillChatPickers();
      return loadLive().then(function () { renderStatus(); render(); fillChatPickers(); });
    }).catch(function (e) {
      $("data-status").setAttribute("data-state", "error");
      $("data-status").innerHTML = '<p class="verdict warn">Could not load the model catalog (' + esc(e.message) + "). Try serving the folder with python3 -m http.server.</p>";
      var head = $("top-pick");
      head.setAttribute("aria-busy", "false");
      head.classList.add("is-empty");
      head.innerHTML = '<p class="eyebrow">No ranking</p><h3>The model catalog did not load</h3><p>Rankings need the catalog. See the message at the top of the page.</p>';
      $("compare-body").innerHTML = '<tr class="empty-row"><td colspan="12">No catalog loaded.</td></tr>';
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(this);
