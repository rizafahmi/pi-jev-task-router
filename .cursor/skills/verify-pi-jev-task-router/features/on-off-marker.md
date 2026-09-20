# On-off marker

The disabled marker file (`~/.pi/agent/pi-jev-task-router.disabled`) persists the on/off state across `/reload` and Pi restarts. Written by `/task-router off` or when Jev rejects the API key; deleted by `/task-router on`.

## Sub-features

- `toggle-off-creates-marker` — `/task-router off` writes the marker file, routing stops
- `toggle-on-deletes-marker` — `/task-router on` deletes the marker, routing resumes
- `marker-survives-reload` — After `/task-router off` then `/reload`, routing stays disabled
- `marker-survives-restart` — After `/task-router off`, quit Pi, restart Pi, routing stays disabled
- `jev-key-rejected-auto-off` — When Jev returns 401/403, router writes marker with reason, turns off

## How to get to it (user POV)

- Inside Pi TUI: `/task-router off`, `/reload`, observe routing still disabled
- Inside Pi TUI: `/task-router off`, `/quit`, restart `pi`, observe routing still disabled
- Set invalid `TYPESAFE_API_KEY`, send a prompt, observe auto-off with reason

## Driving it with the control script and Pi TUI

Preconditions:

- **Requires Pi on PATH**
- Extension loaded
- Marker path: `~/.pi/agent/pi-jev-task-router.disabled` (or `$PI_CODING_AGENT_DIR/pi-jev-task-router.disabled`)

- **Toggle off, create marker.** Disable routing. Inside Pi TUI, type `/task-router off` and press Enter. Expect notify `task-router disabled - model will stay wherever you leave it` (warning). Run `ls -l ~/.pi/agent/pi-jev-task-router.disabled` from another terminal; file exists, zero bytes or contains empty string (user-initiated off has no reason text).
- **Reload, marker survives.** Reload extension. Inside Pi TUI, type `/reload` and press Enter. Expect session_start says `disabled` instead of showing classifier. Type `/task-router`; expect output `task-router is disabled - /task-router on to enable`. Routing is still off after reload.
- **Restart, marker survives.** Quit and restart Pi. Inside Pi TUI, type `/quit` or press Ctrl+D. Run `pi` again. Expect session_start says `disabled`. Type `/task-router`; expect output still shows disabled. The marker persists across Pi restarts.
- **Toggle on, delete marker.** Re-enable routing. Inside Pi TUI, type `/task-router on` and press Enter. Expect notify `task-router enabled` (info). Run `ls ~/.pi/agent/pi-jev-task-router.disabled`; file not found (deleted). Type `/task-router`; expect output `task-router is enabled (fake)` or `enabled (jev-1.13.0)`.
- **Auto-off on rejected key (optional, requires invalid key).** Simulate rejected API key. Set `TYPESAFE_API_KEY=sk-invalid` and `TASK_ROUTER_PROVIDER=jev`. Restart Pi. Send a user prompt (e.g. `Fix the bug`). Expect notify `router: jev rejected the API key (HTTP 403) - fix TYPESAFE_API_KEY, then /task-router on to re-enable` (error). Footer shows `off (jev key rejected)`. Run `cat ~/.pi/agent/pi-jev-task-router.disabled`; file exists, contains reason text (the HTTP 403 message). Type `/task-router`; expect output shows disabled with the rejection reason. Routing is auto-off; no heuristic fallback for that turn (deliberate: a set key means user asked for Jev, not keywords).
- **Proof.** Capture marker lifecycle. For each step: (1) capture `/task-router` output showing state, (2) run `ls -l ~/.pi/agent/pi-jev-task-router.disabled || echo "not found"`, (3) copy output to `.cursor/skills/verify-pi-jev-task-router/evidence/on-off-marker/<step>.txt`. Files show marker created on off, survives reload/restart, deleted on on, contains reason when auto-off.

## Gotchas

- The marker is written to Pi's agent directory (`~/.pi/agent/` or `$PI_CODING_AGENT_DIR`), NOT inside the extension directory. This is deliberate: installed packages are git-managed and cleaned on ref changes, so a marker inside the package would disappear on `pi update --extensions`.
- The marker content is either empty (user-initiated `/task-router off`) or contains the auto-off reason (e.g. "jev rejected the API key (HTTP 403) - fix TYPESAFE_API_KEY, then /task-router on to re-enable"). `/router-config` and `/task-router` show the reason when present.
- `/reload` reloads extensions but does not reset the marker. Only `/task-router on` deletes it.
- When Jev rejects the API key (401/403), the router does NOT fall back to the heuristic for that turn. It treats key rejection as a setup error (misconfigured, not unavailable), turns off, and tells the user to fix the key. Transient failures (5xx, timeout) do fall back to heuristic and do NOT auto-off.
- Auto-off writes the marker with the reason, so even after `/reload` or restart, `/task-router` still explains why it is off ("disabled - jev rejected the API key ...") instead of the generic "disabled - /task-router on to enable".
- The confirm gate "always allow" flag is per session instance and does NOT persist to the marker. It resets on `/task-router on`, `/reload`, or restart. Only the enabled/disabled state persists.
- If the marker file cannot be written (permission error, disk full), `/task-router off` reports the error but does not throw. Routing stays enabled in that case (fail-open for the toggle command, not for auto-off).
- Slash commands (`/router-config`, `/router-check`, `/router`) still work when routing is disabled. Only the `before_agent_start` hook (classify + setModel) is skipped.
