# CLAUDE.md — Model Scout

Interactive website that researches LLMs and recommends the right model for a task.

## What it is
- Task profiler: plain-language task + constraints (budget, latency, quality, privacy, context, modality).
- Model catalog as data (JSON): model, provider, context, input/output price, latency class, strengths, limits, source + last verified date.
- Client-side ranking + cost estimator: weighted scoring, plain-language reasons, monthly cost at expected volume.
- "What to use when" playbook + switch triggers.
- Live data where possible (public model endpoints, no keys); bundled catalog fallback, clearly dated.
- Honesty rule: no invented benchmarks or specs. Unverified specs are flagged, never presented as current.
- Ask a model (section 3): chat with one model, or one question to two models side by side; "Ask this model" on every card.
- Presets (seven common cases) and shareable links: the form settings live in the query string (`encodeSettings` / `decodeSettings`); the task description never does.
- Hard capability constraints (tool calling, JSON output, reasoning mode), prompt-cache share and batch prices in the cost math (never stacked: `effectivePrices` uses whichever is cheaper for the token mix, `batchSkipped` when the cache wins), retirement dates as warnings. Sample counter (`estimateTokens`, `sampleEstimate`): about 4 characters per token, 1 per CJK character; fills tokens per request and a cache share (none under `CACHE_MIN_TOKENS`); pasted text never leaves the page or enters the link. Monthly spend limit (`monthlyCap`, link key `cap`, read from "$200 a month" in a description): a hard limit at the volume; self-hosted models are not checked. Zero data retention (`zdr`, link `zdr=1`): `zdrFacts` from OpenRouter's ZDR endpoint list (`refresh_catalog.js --zdr`, dated `zdr_snapshot`); required, it excludes models with 0 endpoints, flags unknown ones, raises a price to the cheapest ZDR endpoint but never lowers it, and sets batch aside.
- Confidence check on the top pick (`robustness`): 300 seeded reruns with each weight scaled between half and double; reports ties and dominated runners-up.
- Value map (`valueMapSvg`, `frontier`): score against monthly cost on a log scale, with the Pareto frontier; drawn at the container width. "Cheaper option within 5 points" under the top pick (`cheaperAlternative`). Split traffic (`routeOptions`, `routeSplit`, `routeText`): a share of requests to a cheaper ranked model, priced in proportion; cost only, no blended score; in the memo once used.
- Tipping points (`tippingPoints`): per factor, the exact weight share at which another model comes first (scores are linear in one share when the others keep their proportions). "Try it" (`tipWeights`) sets whole-percent weights just past the tip, verified by re-ranking. Hand-set weights (`normalizeWeights`, link key `w=cost-quality-speed-context-privacy`, one decimal): sliders in the weights box replace the profile weights; hard constraints still apply. "Back to profile weights" clears them.
- Market watch (section 5, `marketWatch`): models first listed on OpenRouter in the last 30 days (`listed_on`), reviewed models whose live price differs from the snapshot (`mergeLive` keeps it in `live.before`), and listed retirement dates. Each row is checked against the profile's hard limits with a monthly cost. Bundled-only mode says so and compares no prices.
- What if (`leverOptions`, `whatIfs`): one constraint changed at a time, re-ranked; kept only when the pick moves or the same pick saves at least 5%. No saving is quoted when either side is local only. Apply sets the form; Undo restores it until the next edit. The memo lists the levers.
- Compare tray and head to head (`headToHead`, up to 3 models), with "Ask the first two side by side". Decision memo as Markdown (`decisionMemo`): copy or download; it includes the description, the share link does not.

## Run
- Open `index.html` directly, or serve the repo root: `python3 -m http.server 8000`.
- All asset paths are relative, so the app also works served from a subpath (e.g. battlettt.github.io/model-scout/).

## Test
- `node tests/run_tests.js` (ranking math, cost math, stale-data flagging, catalog validation, UI static checks: IDs, assets, labels, contrast, motion).
- DOM smoke tests (`tests/dom_smoke.js`) run from the same command when jsdom is on the module path (`NODE_PATH=.../node_modules`); otherwise they are skipped.
- Chat tests stub fetch. Never make a real chat call in tests or checks; the owner verifies with their own key.
- Every catalog entry must have a source + date or be flagged.
- `node --check` every JS file. No browser in CI: tests cover the engine, catalog, and static checks.

## Layout
- `index.html`, `styles.css`, `app.js`, `catalog.json` at the repo root are the whole app (deploy these four; the favicon is an inline SVG).
- `app.js`: pure engine (weights, scoring, cost, staleness, validation, live merge, switch check, robustness, settings links, presets) exported for node, then browser UI.
- `tools/refresh_catalog.js`: refreshes catalog.json from a saved OpenRouter model list (prices, context, capabilities, input types, cache and batch prices, output limits, dates) and re-embeds it. Never touches editorial fields. Not deployed.
- `index.html` embeds a copy of `catalog.json` for `file://` use. After editing the catalog run `node tests/sync_embedded_catalog.js`; a test fails if they drift.
- `AGENTS.md` is a symlink to this file (git mode 120000). Do not replace it with a regular file.

## Chat rules
- OpenRouter: POST https://openrouter.ai/api/v1/chat/completions, `{model, messages}`, `Authorization: Bearer <key>`. Default model `cognitivecomputations/dolphin-mistral-24b-venice-edition`; Nous Hermes 3 70B also offered.
- The key lives in the browser's localStorage only (`model-scout.openrouter-key`). Never write any key into the repo, tests, or a commit.
- Local: POST http://localhost:11434/api/chat, `{model: "dolphin3", messages, stream: false}`, no key. Works only when served from localhost.
- Side by side fires both requests at once; each column settles on its own (`runCompare`). Streaming is opt-in and falls back to a whole-body read.
- Chat helpers (`buildChatRequest`, `sendChat`, `runCompare`, `askTarget`, key storage) are pure and exported for tests.

## Data rules
- Stale = `last_verified` missing, invalid, future, or older than 90 days (`STALE_AFTER_DAYS` in app.js, `stale_after_days` in catalog.json).
- Prices are USD per million tokens; null only with `price_status: "unverified"`. Field-level doubts go in `unverified_fields`.
- `quality_tier` and `latency_class` are editorial, from provider positioning. Never add benchmark numbers.
- Live data: browser fetches https://openrouter.ai/api/v1/models (no key). On failure, fall back to the bundled catalog and say so.
- Capabilities come only from OpenRouter's `supported_parameters` (tools; response_format or structured_outputs; reasoning or include_reasoning). Batch prices come from the `:batch` variant and are used only when lower. Unknown stays null and is flagged, never guessed.
- Refresh: `curl -s https://openrouter.ai/api/v1/models -o /tmp/or.json && node tools/refresh_catalog.js /tmp/or.json` (add `--dry-run` to preview; add `--zdr /tmp/zdr.json` from https://openrouter.ai/api/v1/endpoints/zdr to refresh ZDR data).
- User-facing copy: no em dashes.

## Conventions
- No build step. Plain HTML, CSS, JavaScript.
- No secrets, tokens, or API keys in the repo.
- Keep the catalog current: refresh data before release, flag anything stale.
