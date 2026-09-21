# Slash commands

Pi TUI slash commands for inspecting router state, toggling routing, and viewing the last decision. Four commands: `/router-config`, `/router`, `/task-router on|off`, and `/task-router` (bare, shows state).

## Sub-features

- `router-config` — Shows active classifier, masked key, thresholds, tier table, resolved models
- `router` — Shows the last routing decision (prompt, kind, tier, confidence, outcome)
- `task-router-on` — Enables routing, clears disabled marker, resets confirm gate
- `task-router-off` — Disables routing, writes marker file, model stays wherever user leaves it
- `task-router-status` — Shows whether routing is enabled and with which classifier

## How to get to it (user POV)

- Inside Pi TUI: type `/router-config`, `/router`, `/task-router`, `/task-router on`, or `/task-router off`
- These are extension-registered commands (not built-in Pi commands)

## Driving it with the control script and Pi TUI

Preconditions:

- **Requires Pi on PATH**
- Extension loaded into Pi (`pi install file:///workspace` or clone to extensions dir)
- Pi TUI launched with `pi`
- No `TYPESAFE_API_KEY` needed for this feature (heuristic classifier is sufficient)

- **Launch Pi.** Start Pi TUI. Run `pi` with no args. Expect Pi prompt appears, extension loads.
- **Show config.** Send `/router-config`. Inside Pi TUI, type `/router-config` and press Enter. Expect output shows: `router: classifier = heuristic (TYPESAFE_API_KEY is unset)` or `jev ...` if key is set, `TYPESAFE_API_KEY unset` or masked (e.g. `set (sk-***...)`), base URL, model name, confidence/unsure floors, confirm gate status, marker path + enabled/disabled state, tier table label, resolved models per tier (fast_cheap=..., balanced=..., frontier=...), and allowlists. No errors.
- **Check status.** Send `/task-router`. Inside Pi TUI, type `/task-router` and press Enter. Expect output shows `task-router is enabled (via heuristic)` or `enabled (via jev ...)` or `disabled - ...` with reason.
- **Disable routing.** Send `/task-router off`. Inside Pi TUI, type `/task-router off` and press Enter. Expect notify: `task-router disabled - model will stay wherever you leave it` (warning level). The marker file `~/.pi/agent/pi-jev-task-router.disabled` is written.
- **Confirm disabled state.** Send `/task-router` again. Expect output shows `task-router is disabled - /task-router on to enable`.
- **Re-enable routing.** Send `/task-router on`. Inside Pi TUI, type `/task-router on` and press Enter. Expect notify: `task-router enabled` (info level). The marker file is deleted, confirm gate "always allow" flag is reset.
- **View last decision (none yet).** Send `/router`. Inside Pi TUI, type `/router` and press Enter. Expect notify: `router: nothing routed yet in this session instance` (info level). This is correct if no user prompt has been sent since Pi started.
- **Send a user prompt.** Route a simple bugfix prompt. Inside Pi TUI, type `Fix the crash when saving a draft` and press Enter. Expect Pi processes the prompt (agent turn runs), footer shows `bugfix/S - fast_cheap` or similar, notify shows `routed: bugfix/S -> fast_cheap -> <model>`.
- **View last decision (populated).** Send `/router` again. Inside Pi TUI, type `/router` and press Enter. Expect output shows: prompt excerpt "Fix the crash when saving a draft", kind/complexity/tier using arrows (`bugfix/S -> fast_cheap`), confidence (e.g. 0.92), `repo_map no`, outcome (model ref or "ask_human"), and provenance line (`via fake` or `via jev · ...` with optional cache/version detail).
- **Proof.** Capture slash command outputs. Copy each command's output from Pi TUI into separate files under `.cursor/skills/verify-pi-jev-task-router/evidence/slash-commands/`: `router-config.txt`, `task-router-toggle.txt` (showing off/status/on sequence), `router-last-decision.txt`. Files show expected structure, no errors, recognizable output shape.

## Gotchas

- `/router-config` shows the resolved models *right now* from the active model registry. If a tier's allowlist entry does not exist in `pi --list-models` or has no configured auth, that tier shows `UNRESOLVED`. This is not an error; it means the tier table needs adjustment via `TASK_ROUTER_TIERS` env var.
- The confirm gate "always allow" flag is per session instance: it resets on `/reload`, `/task-router on`, or a new Pi launch. It does NOT persist to the marker file.
- `/router` shows nothing until at least one user prompt has been routed in the current session. Built-in commands like `/model` are dispatched before `before_agent_start`, so they are never classified and never appear in `/router` output.
- `/task-router off` writes `~/.pi/agent/pi-jev-task-router.disabled` (honoring `$PI_CODING_AGENT_DIR`), not inside the extension directory. This is deliberate: installed packages are git-managed, and a marker inside them would disappear on `pi update --extensions`.
- The footer marker `task-router: <kind>/<complexity> - <tier>` survives until the next routed prompt. It is useful for confirming routing happened, but it does not update if the model is changed manually with `/model`.
- Slash commands work even when routing is disabled (`/task-router off`). Only the `before_agent_start` hook (which classifies and switches models) is disabled; the inspection commands remain available.
