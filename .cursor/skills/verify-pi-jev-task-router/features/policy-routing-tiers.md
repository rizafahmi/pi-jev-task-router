# Policy routing tiers

The policy maps task_kind to a base tier, then applies escalation rules: security→at least frontier, complexity L + fast_cheap→balanced, confidence floors→balanced or ask_human. The kind→tier table is in `policy.ts` (`BASE_TIER`), shared by both classifiers.

## Sub-features

- `kind-to-tier-baseline` — bugfix/tests/docs→fast_cheap, refactor/feature→balanced, security→frontier, unclear→ask_human
- `security-escalation` — Any security classification routes to at least frontier tier (never downgraded)
- `complexity-bump` — Large complexity (L) on fast_cheap tier escalates to balanced
- `confidence-floors` — Confidence <0.5→ask_human (unless frontier), confidence <0.7→at least balanced
- `ask-human-veto` — ask_human tier does not call setModel, warns user, leaves model unchanged (unless already frontier)

## How to get to it (user POV)

- Send user prompts in Pi TUI, observe routing notify and footer
- Inspect `/router` output after a routed prompt to see tier, confidence, rationale
- Read `policy.ts` for `BASE_TIER` table and `applyPolicy()` logic

## Driving it with the control script and Pi TUI

Preconditions:

- **Requires Pi on PATH** for TUI prompts
- Extension loaded, routing enabled (`/task-router on`)
- Optional: `TYPESAFE_API_KEY` for live Jev (heuristic also proves policy, with canned classifications)

- **Baseline bugfix→fast_cheap.** Send a bugfix prompt. Inside Pi TUI, type `Fix the crash when saving a draft` and press Enter. Expect notify shows `routed: bugfix/S -> fast_cheap -> <model>`. The footer shows `bugfix/S - fast_cheap`. `/router` confirms `bugfix` kind, `fast_cheap` tier.
- **Baseline refactor→balanced.** Send a refactor prompt. Inside Pi TUI, type `Refactor the billing context into smaller modules` and press Enter. Expect notify shows `routed: refactor/M -> balanced -> <model>`. Footer shows `refactor/M - balanced`.
- **Security→frontier (escalation).** Send a security prompt. Inside Pi TUI, type `There's an IDOR in the orders endpoint - users can read other people's orders` and press Enter. Expect notify shows `routed: security/L -> frontier -> <model>`. Footer shows `security/L - frontier`. Even if `BASE_TIER[security]` were set to balanced (it's not, it's already frontier), the policy escalates security to frontier.
- **Large complexity bump.** Send a test prompt with large complexity. Inside Pi TUI, type `Fix the flaky tests everywhere in the repo` and press Enter. Expect notify shows `routed: tests/L -> balanced -> <model>` (not fast_cheap). `BASE_TIER[tests]` is fast_cheap, but complexity L escalates it to balanced per `applyPolicy()` rule 2.
- **ask_human veto (unclear).** Send a vague prompt. Inside Pi TUI, type `do it` and press Enter. Expect notify shows `router: not routing (unclear/S -> ask_human, vague phrasing) - clarify the task or pick a model with /model` (warning level). No model switch. Footer unchanged from previous prompt. `/router` confirms outcome `ask_human`.
- **Confidence floor <0.5→ask_human.** This requires live Jev or a mocked low-confidence response. With live Jev and `TYPESAFE_API_KEY` set, send a genuinely ambiguous prompt that Jev hedges on (e.g. "help"). Expect confidence <0.5, policy routes to ask_human, notify warns, no model switch.
- **Confidence floor <0.7→balanced.** Send a prompt that Jev classifies as refactor but with medium confidence (0.65–0.69 range). Expect the policy escalates to balanced (if not already at balanced or higher). This is harder to trigger predictably; `/router-check --jev` fixture "Improve error handling in the parser" shows this (Jev hedges, confidence ~0.65, floor lifts it to balanced).
- **Proof.** Capture routing examples. For each sub-feature, copy the prompt, notify line, footer, and `/router` output into `.cursor/skills/verify-pi-jev-task-router/evidence/routing/policy-<sub-feature>.txt`. Files show kind→tier mapping matches policy rules, escalations apply, ask_human veto prevents model switch.

## Gotchas

- Frontier is terminal: a security prompt with `needs_human=yes` still routes to frontier (ask_human veto does not apply at frontier tier).
- Confidence is only from `task_kind` choice, not complexity. Complexity confidence is systematically low (~0.3) per Jev's nature, so the policy ignores it. `Decision.confidence` = task_kind confidence.
- `ask_human` tier means "do not guess a model"; it warns the user but does not block the turn. The agent still runs, using whatever model is currently active.
- Policy rules apply in order (see `applyPolicy()` in policy.ts): security escalation first, complexity bump, then ask_human/confidence veto rules. Rules 3 and 4 (ask_human conditions) return early when triggered, so later confidence floors cannot undo an ask_human outcome. Tier upgrades (security→frontier, L+fast_cheap→balanced) happen before veto checks.
- The keyword heuristic (fake provider) is deliberately biased toward security: it matches "XSS", "IDOR", "SQL injection", "login" as security. Over-triggering security is safer than under-triggering it.
- Tier resolution happens after policy: `applyPolicy()` outputs a tier, then `resolveTierModel()` looks up the first allowlist entry that exists in the registry with auth. If no entry resolves, notify warns `no usable model for <tier>`, no model switch, outcome `unresolved`.
- Confirm gate applies before setModel: if the target tier is more expensive than current model, TUI prompts "Switch / Always allow / Stay" (30s timeout, default Stay). Only in TUI mode; `pi -p` and `--mode json` bypass the gate.
