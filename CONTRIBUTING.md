# Contributing

Small, single-purpose extension. The most useful contributions are **fixtures**,
**question wording**, and **thresholds** — not new architecture.

## Run it

```sh
npm test          # node --test; 23 tests, no key, no network, no install needed
npm run typecheck # tsc --noEmit (typescript is a devDependency)
```

Both run in CI on Node 24 (`.github/workflows/ci.yml`). Tests execute `.ts` directly via
Node's type stripping, so there is no build step and no toolchain to install — `npm ci` is
only needed for the typecheck.

To exercise it by hand, clone into the directory Pi auto-discovers and reload:

```sh
git clone <your fork> ~/.pi/agent/extensions/pi-jev-task-router
```

```text
/reload
/router-config      # classifier, key, marker path, tier table, resolved models
/router-check       # 17 fixtures through the heuristic + policy, offline
/router-check --jev # same fixtures against the live API (needs TYPESAFE_API_KEY)
```

## Where the knobs are

Three deliberate single places. Change one of these before you change any surrounding code:

| what | where |
|---|---|
| the four questions Jev is asked, and their option descriptions | `providers/jev-questions.ts` |
| thresholds, `BASE_TIER`, the default tier → model allowlist, price ranks | `policy.ts` |
| which models your machine uses, without editing code | `TASK_ROUTER_TIERS` env var (`parseTierModels`) |
| expected kind/complexity/tier per prompt | `fixtures.jsonl` |

`applyPolicy()` and `parseTierModels()` are pure functions over plain data. Keep them that
way: if a change makes the policy need a registry, a key, or the network to test, the change
is in the wrong layer.

## Adding a fixture

`fixtures.jsonl` is one JSON object per line, and `/router-check` asserts all three fields
against the heuristic:

```json
{"prompt": "Fix the crash when saving a draft", "expect_kind": "bugfix", "expect_complexity": "S", "expect_tier": "fast_cheap", "note": "why this case exists"}
```

The heuristic is deterministic, so a mismatch is a real regression and fails. Under
`--jev` only the **tier** is asserted; kind/complexity disagreements are printed as tuning
notes, because a judgement model is allowed to disagree about *how* to describe a task.

If you add or rename a tier expectation, keep the counts in the README honest — it states the
fixture histogram, and it is checked by hand, not by CI.

## Notes on the Pi extension API

Things that cost time to rediscover. Verified against `@earendil-works/pi-coding-agent`
0.85.1:

- `pi.setModel(model)` resolves to `false` when the provider has no auth. The model is then
  left unchanged — treat it as a refusal, not an exception, which is what `index.ts` does.
- `ctx.modelRegistry.find(provider, modelId)` + `hasConfiguredAuth(model)` are how the
  allowlist is validated at call time. Nothing is assumed to exist; unresolved entries are
  skipped. `resolveTierModel` takes only those two capabilities (`ModelLookup`), which keeps
  `policy.ts` free of Pi imports and the tests free of a registry.
- `ctx.model` is the active model, used to skip a redundant `setModel`.
- `before_agent_start` fires **after** prompt/template expansion and **before** the agent
  loop reads the model, so a switch inside it applies to the current turn.
- Built-in slash commands are dispatched **before** that hook, so `/model` can never be
  routed. `BUILTIN_COMMANDS` in `index.ts` is a copy of `BUILTIN_SLASH_COMMANDS` from
  `dist/core/slash-commands.js`; that constant is not exported from the package index, so it
  is copied verbatim and the version is stated next to it. Re-check it on a Pi upgrade.
- `ctx.ui.notify` and `ctx.ui.setStatus` are **no-ops without a UI**. Pi swaps in
  `noOpUIContext` (`dist/core/extensions/runner.js:88-100`) for `-p` and `--mode json`; only
  interactive and RPC implement them. `ctx.hasUI` tells you which you are in, so anything a
  headless user must know has to be written to stderr as well (see `session_start`).
- `TYPESAFE_API_KEY` is normalised at load (`normalizeApiKey`): absent and blank are one state.
  A blank key used to be read as present, which selected Jev, 403'd on every call, and reported
  the classifier as "jev" while degrading on every prompt.
- The on/off marker lives in Pi's agent dir, not next to the code: `PI_CODING_AGENT_DIR`
  (tilde-expanded) or `~/.pi/agent`. A marker inside an installed package would be wiped
  when Pi reconciles the checkout. This mirrors Pi's own `getAgentDir()` deliberately, to keep
  the extension's imports type-only.
- Pi installs git packages with `npm install --omit=dev`, so `devDependencies` here are
  genuinely dev-only. It also resolves package resources through the `pi` manifest (or
  `extensions/`), which is why `package.json` points `pi.extensions` at `./index.ts` — a bare
  root `index.ts` is discovered for local/clone paths but **not** for `pi install git:…`.

## Consistency

- **Runtime dependencies stay at zero.** The extension imports only `node:*` and type-only
  imports from the Pi package. Talk to new services with `fetch`. If a dependency is truly
  needed, say so in the PR description first.
- Keep rejection reasons user-facing and actionable: they are shown in a notify, not a log.
  Say which key or env var is wrong and what a valid value looks like.
- Add a test for any change to `applyPolicy`, `parseTierModels`, price ordering, or the Jev
  response mapping. Those are the parts that can quietly route badly.
