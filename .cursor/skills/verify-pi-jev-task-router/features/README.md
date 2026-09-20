# pi-jev-task-router verification map

This directory is the maintained source for verifying the user-facing behavior of `pi-jev-task-router`. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

**For offline path (always available):**

- Working directory: `/workspace` (the pi-jev-task-router repo root)
- Node ≥22.19 on PATH
- `package.json` and `fixtures.jsonl` present
- No network, no API key, no Pi instance required

**For Pi TUI path (requires Pi installed):**

- `pi` on PATH (Pi coding agent ≥0.85.1)
- Extension loaded: `pi install file:///workspace` or clone to `~/.pi/agent/extensions/pi-jev-task-router`
- Optional: `TYPESAFE_API_KEY=sk-...` for live Jev (without it, heuristic classifier is used)
- Launch with `pi` (no args), sends prompts in the TUI

## Driving conventions

- **Offline path:** Run commands from repo root (`/workspace`), capture terminal output as evidence.
- **Pi TUI path:** Start Pi, send slash commands and user prompts inside the TUI, capture output.
- Treat every command as literal. Keep quoted prompts unchanged.
- Run doctor before any feature drive: `.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor`
- Never assume Pi is installed; document TUI paths as "requires Pi on PATH" when unreachable.

## Proof and skip reporting

- **Offline proof:** Doctor passes (tests + typecheck + fixture parse), exit code 0, green output.
- **Slash command proof:** Command returns expected structure, no error level, recognizable shape.
- **Routing proof:** User prompt → notify line + footer change → `/router` confirms decision details.
- **Live Jev proof:** `/router-check --jev` completes with tier match count (expect 16/17 on reference build), security prompt routes to frontier tier.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition (e.g. "requires Pi; pi not on PATH").
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the control script and Pi TUI` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Pure unit and typecheck](./pure-unit-and-typecheck.md) covers `node --test` (23 tests) and `npm run typecheck` (offline, no Pi).
- [Offline router-check](./offline-router-check.md) covers `/router-check` with fixtures and heuristic (no API key).
- [Slash commands](./slash-commands.md) covers `/router-config`, `/router`, `/task-router on|off` in the Pi TUI.
- [Policy routing tiers](./policy-routing-tiers.md) covers kind→tier mapping, security→frontier escalation, and ask_human veto.
- [On-off marker](./on-off-marker.md) covers the disabled marker file behavior that survives `/reload`.
