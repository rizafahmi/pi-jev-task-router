# Pure unit and typecheck

Pure offline verification: Node's built-in test runner against policy + classifier mapping, and TypeScript typecheck. No Pi instance, no API key, no network. Always driveable.

## Sub-features

- `unit-tests` — `node --experimental-strip-types --test` runs 30 tests (policy.test.ts, jev.test.ts) with canned responses
- `typecheck` — `tsc --noEmit` proves type correctness (needs devDeps installed)
- `fixture-parse` — `fixtures.jsonl` is valid JSON lines with expected schema

## How to get to it (user POV)

- Run `node --experimental-strip-types --test` directly from the repo root
- Run `npm run typecheck` from the repo root (package.json script)
- Run the control helper's `doctor` command which wraps both

## Driving it with the control script and Pi TUI

Preconditions:

- Working directory is `/workspace` (the pi-jev-task-router repo root)
- Node ≥22.19 on PATH
- No Pi instance required, no network required

- **Run tests directly.** Execute Node's test runner. Run `cd /workspace && node --experimental-strip-types --test`. Expect exit code 0, output shows 30 tests passed across `policy.test.ts` and `providers/jev.test.ts`.
- **Run typecheck directly.** Execute tsc. Run `cd /workspace && npm install && npm run typecheck`. Expect exit code 0, no type errors reported. The `npm install` step is needed once to populate `node_modules/` with `typescript`, `@types/node`, and Pi types (all devDependencies).
- **Run doctor wrapper.** Execute control script. Run `.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor`. Expect exit code 0, output shows "=== Running tests ===" section with 30 passed, "=== Running typecheck ===" section with no errors, "=== Checking fixtures ===" section confirming 17 lines parsed. If `node_modules/` is missing, the script runs `npm ci` automatically.
- **Inspect fixture schema.** Parse fixtures.jsonl. Run `cd /workspace && head -3 fixtures.jsonl | jq -c '.'`. Each line is a JSON object with `prompt`, `expect_kind`, `expect_complexity`, `expect_tier`, `note` fields.
- **Proof.** Capture doctor run output. Run `.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor > .cursor/skills/verify-pi-jev-task-router/evidence/offline-path/doctor-output.txt`. File shows all checks passed with exit 0.

## Gotchas

- `node --experimental-strip-types --test` runs `.ts` files directly from Node 22.14+, no build step, but `npm run typecheck` needs `npm install` for devDependencies. The control script handles this automatically.
- Pi packages are installed with `--omit=dev`, so devDeps (TypeScript, @types/node, Pi types) never reach a user. CI and verification runs need them.
- The tests are pure: no Pi registry, no model catalogue, no network. They use canned Jev responses (jev.test.ts) and pure policy logic (policy.test.ts).
- If `npm ci` fails due to missing package-lock.json, use `npm install` instead. The control script uses `npm ci` when package-lock.json exists.
