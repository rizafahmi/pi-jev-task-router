---
name: verify-pi-jev-task-router
description: "Drive pi-jev-task-router the way a user does: pure unit tests + typecheck (offline), then Pi TUI slash commands (/router-config, /router-check, /router, /task-router) with optional live Jev classification. Use when verifying changes to the task-router extension or confirming that routing, policy, and classifier integration work end-to-end."
---

# Verify pi-jev-task-router

This skill drives `pi-jev-task-router`, a Pi coding-agent extension that classifies prompts and routes them to model tiers before each agent turn. The package provides a library (the extension itself), slash commands in the Pi TUI, and a pure offline test + policy verification path that requires no Pi instance and no API key.

## Surface

- **Primary:** Pi TUI slash commands (`/router-config`, `/router-check`, `/router`, `/task-router on|off`)
- **Secondary:** Offline verification via `node --test` (23 pure unit tests), `npm run typecheck`, and fixture validation
- **NOT a web UI:** This is a library + TUI extension, no HTTP server, no browser automation

## Launch

The app has two distinct launch modes for verification:

### Offline path (always available)

No Pi instance needed. Proves tests + typecheck + fixture parsing:

```bash
cd /workspace
node --experimental-strip-types --test   # 32 tests, no key/network
npm run typecheck                        # requires npm install for devDeps
```

The control helper wraps both:

```bash
.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor
```

### Live Pi TUI path (requires Pi installed)

When `pi` is available on the machine and the extension is loaded:

```bash
# Install the extension
pi install file:///workspace  # or clone to ~/.pi/agent/extensions/pi-jev-task-router

# Launch Pi
pi

# Inside Pi TUI, extension slash commands are now available:
# /router-config, /router-check, /router, /task-router
```

**Optional:** Set `TYPESAFE_API_KEY=sk-...` to enable live Jev classification. Without it, the router uses the keyword heuristic (which is still a valid verification path).

**Teardown:** Exit Pi with `/quit` or Ctrl+D. No persistent processes. Extension state (on/off marker) lives at `~/.pi/agent/pi-jev-task-router.disabled`.

## Doctor

The doctor check proves the offline path is healthy. Run before driving any feature:

```bash
.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor
```

**What it checks:**

1. `node --experimental-strip-types --test` passes (32 tests: policy, Jev response mapping, tier resolution, fixture parsing)
2. `npm run typecheck` passes (runs `tsc --noEmit`; installs devDeps if needed)
3. `fixtures.jsonl` parses as valid JSON lines

**Expected output:** All checks pass, exit 0. If typecheck needs `npm install`, the doctor runs it automatically.

**When to skip:** Never. The offline path is always driveable, even when Pi is not installed.

## Drive

Drive recipes are split by Pi availability.

### When Pi is NOT available (offline path)

Prove the offline verification path:

```bash
# 1. Run doctor
.cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor

# 2. Inspect fixtures
cat fixtures.jsonl | head -5
# Confirm 17 lines, each with prompt/expect_kind/expect_complexity/expect_tier

# 3. Read one provider module to confirm structure
head -50 providers/fake.ts
# The heuristic classifier (offline, keyword-based)
```

**Evidence:** Terminal output from doctor run, showing tests passed + typecheck passed + fixture count.

### When Pi IS available (TUI slash commands)

This is the full user path. Requires `pi` on PATH.

#### Feature: slash commands (offline heuristic)

```bash
# Start Pi with the extension loaded
pi

# Inside Pi TUI:
/router-config
# Expect: classifier=fake (heuristic), TYPESAFE_API_KEY [not set], resolved tiers

/router-check
# Expect: 17 fixtures processed, tier assertions, kind/complexity summary

/task-router
# Expect: enabled (fake)

/task-router off
# Expect: disabled message

/task-router on
# Expect: enabled message

/router
# Expect: "nothing routed yet" (no prompt sent since restart)
```

**Evidence:** Screenshot or terminal transcript of each slash command output.

#### Feature: routing a user prompt (heuristic)

```bash
# Inside Pi TUI:
/task-router on

# Send a bugfix prompt:
Fix the crash when saving a draft

# Observe footer: should show task_kind/complexity - tier
# Observe notify: "routed: bugfix/S -> fast_cheap -> <model>"

/router
# Expect: last decision summary with prompt, kind, tier, confidence, outcome
```

**Evidence:** Screenshot showing the prompt, footer change, notify, and `/router` output.

#### Feature: live Jev classification (optional)

Requires `TYPESAFE_API_KEY` set before launching Pi.

```bash
export TYPESAFE_API_KEY=sk-...
pi

# Inside Pi TUI:
/router-config
# Expect: classifier=jev-1.13.0, TYPESAFE_API_KEY [sk-***...], base https://api.typesafe.ai

/router-check --jev
# Expect: 17 fixtures against live Jev API, tier match count (expect 16/17), notes on disagreements

# Send a security prompt:
There's an IDOR in the orders endpoint - users can read other people's orders

# Observe routing to frontier tier
/router
# Expect: security/L -> frontier, high confidence (0.98+)
```

**Evidence:** Screenshot of `/router-check --jev` output + security prompt routing.

## Evidence

Artifacts go under `.cursor/skills/verify-pi-jev-task-router/evidence/`. Organized by feature:

- `offline-path/doctor-output.txt` — terminal output from control script doctor run
- `offline-path/test-summary.txt` — `node --test` output
- `slash-commands/router-config.txt` — `/router-config` output
- `slash-commands/router-check.txt` — `/router-check` output (heuristic)
- `slash-commands/task-router-toggle.txt` — `/task-router on|off` sequence
- `routing/bugfix-prompt.txt` — user prompt + footer + notify for bugfix routing
- `routing/router-last-decision.txt` — `/router` output after a routed prompt
- `jev-live/router-check-jev.txt` — `/router-check --jev` output (if TYPESAFE_API_KEY available)
- `jev-live/security-prompt-routing.txt` — security prompt routed via live Jev

**Proof standards:**

- Offline path: doctor passes, all 32 tests green, typecheck clean, fixtures parse
- Slash commands: each command returns expected structure (no errors, recognizable output shape)
- Routing: prompt → notify + footer change → `/router` confirms decision
- Live Jev: `/router-check --jev` completes, tier match count reported, security prompt routes to frontier

**Unreachable when:** Pi is not installed → TUI paths are unreachable; document as "requires Pi on PATH". No TYPESAFE_API_KEY → live Jev paths unreachable (heuristic still proves routing works).

## Cleanup

Cleanup removes any transient state created during verification, never the evidence.

```bash
# If Pi was launched, exit cleanly
# (inside Pi TUI: /quit, or Ctrl+D)

# Remove the on/off marker if doctor created it
rm -f ~/.pi/agent/pi-jev-task-router.disabled

# Remove node_modules if installed only for verification
# (optional; usually kept for subsequent runs)

# Do NOT remove:
# - .cursor/skills/verify-pi-jev-task-router/evidence/
# - Any committed fixture files
```

**After cleanup:** Evidence directory still exists with all captured artifacts.

## Helpers

- **`helpers/control-pi-jev-task-router.mjs`** — Node script, executable, wraps `node --test`, `npm run typecheck`, and fixture parsing.
  
  Usage:
  ```bash
  .cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs doctor
  .cursor/skills/verify-pi-jev-task-router/helpers/control-pi-jev-task-router.mjs smoke  # alias for doctor
  ```

  The script auto-installs devDependencies if `node_modules/` is missing but `package-lock.json` exists (required for `npm run typecheck`).

## Feature map location

See `features/README.md` for the maintained feature map and `features/*.md` for individual feature drive recipes. The map covers:

1. Pure unit and typecheck (offline, always available)
2. Offline router-check with fixtures + heuristic
3. Slash commands (/router-config, /router, /task-router on|off)
4. Policy routing tiers (kind→tier, security→frontier, ask_human veto)
5. On/off marker (disabled state survives /reload)

Not all features may be driveable without a full Pi instance; the map marks each entry's preconditions clearly.
