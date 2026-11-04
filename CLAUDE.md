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
- `index.html`, `styles.css`, `app.js`, `catalog.json` at the repo root are the whole app (deploy these four).
- `app.js`: pure engine (weights, scoring, cost, staleness, validation, live merge, switch check) exported for node, then browser UI.
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
- User-facing copy: no em dashes.

## Conventions
- No build step. Plain HTML, CSS, JavaScript.
- No secrets, tokens, or API keys in the repo.
- Keep the catalog current: refresh data before release, flag anything stale.
