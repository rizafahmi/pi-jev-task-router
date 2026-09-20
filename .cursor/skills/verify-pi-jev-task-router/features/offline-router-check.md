# Offline router-check

Run `fixtures.jsonl` through the heuristic classifier and policy, offline. No API key, no network, no LLM cost. Proves the keyword fallback and policy integration without Pi.

## Sub-features

- `fixture-run-heuristic` — `/router-check` processes 17 fixtures through fake provider
- `tier-assertions` — Each fixture's expected tier is validated against policy output
- `kind-complexity-summary` — Disagreements between expected and actual kind/complexity are reported

## How to get to it (user POV)

- Inside Pi TUI: send `/router-check` (no flags)
- From terminal: read fixtures.jsonl and manually verify heuristic logic in `providers/fake.ts`

## Driving it with the control script and Pi TUI

Preconditions:

- **Requires Pi on PATH** for the TUI drive path
- Extension loaded into Pi (`pi install file:///workspace` or clone to extensions dir)
- `fixtures.jsonl` present in repo root with 17 lines
- No `TYPESAFE_API_KEY` needed (heuristic path is classifier-agnostic)

- **Launch Pi.** Start Pi TUI. Run `pi` with no args. Expect Pi prompt appears, extension loads (session_start may say "classifier: fake (heuristic)").
- **Run offline router-check.** Send slash command. Inside Pi TUI, type `/router-check` and press Enter. Expect output shows "17 fixtures processed", a table or list with prompt excerpts, expected vs actual kind/complexity/tier, and a summary line like "tier matches: 17/17" or similar. No network activity (heuristic runs locally).
- **Inspect one fixture.** Confirm heuristic logic. Run `cd /workspace && grep -m1 'XSS' fixtures.jsonl`. The prompt "Fix the XSS in the comment form" expects security/L/frontier. The heuristic (providers/fake.ts) matches "XSS" as a security keyword, so expect_tier=frontier should match actual tier.
- **Proof.** Capture `/router-check` output. Inside Pi TUI after running `/router-check`, the output is displayed in the terminal. Copy the full output to `.cursor/skills/verify-pi-jev-task-router/evidence/slash-commands/router-check.txt`. The file shows all 17 fixtures processed, tier match count, and no errors.

## Gotchas

- `/router-check` requires Pi TUI; there is no standalone CLI for it. The offline path without Pi is limited to reading `fixtures.jsonl` and inspecting `providers/fake.ts` source.
- The heuristic is intentionally biased toward security: "login", "XSS", "IDOR", "SQL injection" all trigger security/frontier. Over-triggering security is the safe direction.
- Fixture expectations were written against the heuristic and policy as of one snapshot. If the heuristic changes, tier mismatches in `/router-check` output are notes, not failures (the command still completes successfully).
- `/router-check --fake` forces the heuristic even when `TYPESAFE_API_KEY` is set. Without `--fake` or `--jev`, the command uses the configured classifier (auto/jev/fake from `TASK_ROUTER_PROVIDER`).
- The 17 fixtures cover: 5 fast_cheap, 4 balanced, 4 frontier, 4 ask_human. Security prompts (4) always route to frontier; unclear prompts (4) route to ask_human (no model switch, warning notify).
