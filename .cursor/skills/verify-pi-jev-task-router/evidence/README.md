# Verification Evidence

This directory contains artifacts proving that the verification skill was tested end-to-end for at least one feature.

## Offline path verification (proven)

The offline verification path was exercised on 2026-09-20:

- **Feature:** Pure unit and typecheck (from `features/pure-unit-and-typecheck.md`)
- **Method:** Ran the control helper script's `doctor` command
- **Environment:** Node v22.14.0, no Pi instance, no TYPESAFE_API_KEY

### Artifacts

- `offline-path/doctor-output.txt` — Full output from control script doctor run showing all checks passed
- `offline-path/test-summary.txt` — Test summary showing 30/30 tests passed with zero failures

### Results

✓ All 30 tests passed (policy.test.ts + providers/jev.test.ts)  
✓ Typecheck passed (tsc --noEmit)  
✓ All 17 fixtures parsed successfully

Exit code 0, no errors. The offline path is fully driveable without Pi.

## Pi TUI paths (not exercised)

The following features require `pi` on PATH and were not driven in this proof run:

- Offline router-check (`/router-check` slash command)
- Slash commands (`/router-config`, `/router`, `/task-router on|off`)
- Policy routing tiers (user prompts with classification and model switching)
- On-off marker (disabled state persistence across `/reload`)

These paths are documented in the feature map but marked as "requires Pi on PATH". When `pi` is available, they can be driven following their respective feature files under `features/`.

## Live Jev paths (not exercised)

Features requiring `TYPESAFE_API_KEY`:

- `/router-check --jev` (live Jev classification against fixtures)
- Security prompt routing with live Jev (high-confidence security→frontier)

These paths are optional; the heuristic classifier provides sufficient coverage for offline verification.
