# CLAUDE.md — Model Scout

Interactive website that researches LLMs and recommends the right model for a task.

## What it is
- Task profiler: plain-language task + constraints (budget, latency, quality, privacy, context, modality).
- Model catalog as data (JSON): model, provider, context, input/output price, latency class, strengths, limits, source + last verified date.
- Client-side ranking + cost estimator: weighted scoring, plain-language reasons, monthly cost at expected volume.
- "What to use when" playbook + switch triggers.
- Live data where possible (public model endpoints, no keys); bundled catalog fallback, clearly dated.
- Honesty rule: no invented benchmarks or specs. Unverified specs are flagged, never presented as current.

## Run
- Open `index.html` directly, or serve the repo root: `python3 -m http.server 8000`.
- All asset paths are relative, so the app also works served from a subpath (e.g. battlettt.github.io/model-scout/).

## Test
- `node tests/run_tests.js` (ranking math, cost math, stale-data flagging, catalog validation).
- Every catalog entry must have a source + date or be flagged.

## Conventions
- No build step. Plain HTML, CSS, JavaScript.
- No secrets, tokens, or API keys in the repo.
- Keep the catalog current: refresh data before release, flag anything stale.
