/**
 * task-router — pattern B.
 *
 * On every user prompt, before the agent loop runs:
 *   classify (Jev, or the heuristic fallback) -> applyPolicy -> resolveTierModel
 *   -> pi.setModel -> notify
 *
 * The router itself makes no network calls. All of them live behind
 * ClassifierProvider (providers/types.ts): providers/jev.ts talks to TypeSafe,
 * providers/fake.ts is the offline heuristic that also serves as the fallback.
 *
 * Configuration, all optional except the API key:
 *   TYPESAFE_API_KEY         enables Jev. Unset -> heuristics only.
 *   TYPESAFE_BASE_URL        default https://api.typesafe.ai
 *   TASK_ROUTER_PROVIDER     "auto" (default) | "jev" | "fake"
 *   TASK_ROUTER_JEV_MODEL    default jev-latest; pin e.g. jev-1.13.0
 *   TASK_ROUTER_TIMEOUT_MS   default 4000, the whole call including retries
 *   TASK_ROUTER_MAX_CHARS    default 4000, prompt characters sent as `state`
 *
 * Loaded automatically from ~/.pi/agent/extensions/task-router/index.ts, or for a
 * throwaway test with: pi -e ~/.pi/agent/extensions/task-router/index.ts
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Complexity, Decision, ModelTier, TaskKind } from "./schema.ts";
import {
  applyPolicy,
  CONFIDENCE_FLOOR,
  formatRef,
  isMoreExpensive,
  NOUL_THRESHOLD,
  resolveTierModel,
  routableTier,
  TIER_MODELS,
  UNSURE_FLOOR,
} from "./policy.ts";
import { fakeProvider } from "./providers/fake.ts";
import { createJevProvider, JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL } from "./providers/jev.ts";
import type { ClassifierProvider, ProviderOutcome } from "./providers/types.ts";

/**
 * STEP 0 PROOF (set to true, run one prompt, then set back to false).
 *
 * Bypasses classification and policy entirely and hardcodes one cheap model on
 * every before_agent_start, so you can confirm two things in isolation:
 *   a) setModel inside this hook changes the model for the current turn
 *   b) a mid-session switch takes effect without /model
 * Worth re-running whenever the classifier changes, because it removes the
 * classifier from the list of suspects when a model does not move.
 */
const STEP0_PROOF = false;
const STEP0_MODEL = { provider: "deepseek", modelId: "deepseek-v4-flash" };

/**
 * Built-in interactive commands, copied verbatim from the installed build
 * (dist/core/slash-commands.js, BUILTIN_SLASH_COMMANDS, pi-coding-agent 0.85.1),
 * because that constant is not re-exported from the package index.
 *
 * These are dispatched in interactive mode before an agent turn starts, so this
 * guard is belt-and-braces: it guarantees a literal "/model ..." prompt is never
 * classified and re-routed by us. Registered extension/prompt/skill commands are
 * read from pi.getCommands() instead of being listed here.
 */
const BUILTIN_COMMANDS = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DISABLED_MARKER = join(EXTENSION_DIR, "disabled");

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CONFIG = {
  providerMode: (process.env.TASK_ROUTER_PROVIDER ?? "auto").toLowerCase(),
  apiKey: process.env.TYPESAFE_API_KEY,
  baseUrl: process.env.TYPESAFE_BASE_URL ?? JEV_DEFAULT_BASE_URL,
  model: process.env.TASK_ROUTER_JEV_MODEL ?? JEV_DEFAULT_MODEL,
  timeoutMs: readPositiveNumber("TASK_ROUTER_TIMEOUT_MS", 4000),
  maxChars: readPositiveNumber("TASK_ROUTER_MAX_CHARS", 4000),
  cacheSize: 100,
};

/**
 * What the router will classify with. A misconfiguration is its own state rather
 * than a provider plus a flag: there is no classifier to hand out in that case,
 * because the heuristic would only be pretending to be Jev. Every consumer has to
 * match on the state before it can reach a provider.
 */
type Selection =
  | { kind: "ready"; provider: ClassifierProvider; label: string }
  | { kind: "misconfigured"; reason: string };

/** One line describing what is active, for session_start, /router-config and /task-router. */
function selectionLabel(selection: Selection): string {
  return selection.kind === "ready" ? selection.label : `configuration error (${selection.reason})`;
}

function selectProvider(): Selection {
  if (CONFIG.providerMode === "fake") {
    return {
      kind: "ready",
      provider: fakeProvider("TASK_ROUTER_PROVIDER=fake"),
      label: "heuristic (forced by TASK_ROUTER_PROVIDER=fake)",
    };
  }

  if (!CONFIG.apiKey) {
    const why =
      CONFIG.providerMode === "jev"
        ? "TASK_ROUTER_PROVIDER=jev but TYPESAFE_API_KEY is unset"
        : "TYPESAFE_API_KEY is unset";
    if (CONFIG.providerMode === "jev") return { kind: "misconfigured", reason: why };
    return { kind: "ready", provider: fakeProvider(why), label: `heuristic (${why})` };
  }

  return {
    kind: "ready",
    provider: createJevProvider({
      apiKey: CONFIG.apiKey,
      baseUrl: CONFIG.baseUrl,
      model: CONFIG.model,
      timeoutMs: CONFIG.timeoutMs,
      maxChars: CONFIG.maxChars,
      cacheSize: CONFIG.cacheSize,
    }),
    label: `jev ${CONFIG.model} (timeout ${CONFIG.timeoutMs}ms, first ${CONFIG.maxChars} chars)`,
  };
}

interface LastRoute {
  prompt: string;
  decision: Decision;
  outcome: string;
  /** "jev" or "fake"; fake after a failure is reported in detail. */
  source: string;
  detail: string;
}

interface Fixture {
  prompt: string;
  expect_kind: TaskKind;
  expect_complexity: Complexity;
  expect_tier: ModelTier;
  note?: string;
}

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function describe(decision: Decision): string {
  return `${decision.task_kind}/${decision.complexity} -> ${decision.model_tier}`;
}

const CONFIRM_OPTIONS = ["Switch", "Always allow", "Stay"] as const;
const CONFIRM_TIMEOUT_MS = 30_000;

type ConfirmResult = "switch" | "always" | "declined";

/**
 * Confirm a model change before it happens. Returns:
 *   - "switch"   when there is no gate to clear (headless, not pricier)
 *   - "always"   when the user chose to allow this and every later expensive switch
 *   - "declined" when the user said stay, timed out, or dismissed the dialog
 *
 * The gate only opens in the TUI: headless runs (`-p`, json) and RPC must not
 * block on a dialog, so they fall through as "switch". A timeout or Esc resolves
 * the selector to `undefined`, which is treated as a decline.
 */
async function confirmModelSwitch(
  ctx: ExtensionContext,
  decision: Decision,
  target: { provider: string; id: string },
): Promise<ConfirmResult> {
  if (ctx.mode !== "tui") return "switch";
  if (!isMoreExpensive(ctx.model, target)) return "switch";

  const from = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
  const to = `${target.provider}/${target.id}`;
  const title =
    `Switch model?  ${decision.task_kind}/${decision.complexity} -> ${decision.model_tier} (conf ${(decision.confidence ?? 0).toFixed(2)})\n` +
    `${from} -> ${to}`;

  const choice = await ctx.ui.select(title, [...CONFIRM_OPTIONS], { timeout: CONFIRM_TIMEOUT_MS });
  if (choice === "Switch") return "switch";
  if (choice === "Always allow") return "always";
  return "declined";
}

function maskSecret(secret: string | undefined): string {
  if (!secret) return "unset";
  return secret.length <= 10 ? "set" : `set (${secret.slice(0, 4)}...${secret.slice(-4)})`;
}

function isCommandLike(pi: ExtensionAPI, prompt: string): boolean {
  const match = /^\/([A-Za-z0-9_-]+)/.exec(prompt.trimStart());
  if (!match) return false;
  const name = match[1];
  if (BUILTIN_COMMANDS.has(name)) return true;
  // Registered commands may be suffixed /name:1 when two extensions collide.
  return pi.getCommands().some((command) => command.name === name || command.name.startsWith(`${name}:`));
}

function loadFixtures(): Fixture[] {
  const raw = readFileSync(join(EXTENSION_DIR, "fixtures.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Fixture);
}

export default function taskRouter(pi: ExtensionAPI) {
  const selection = selectProvider();
  const fallback = fakeProvider("jev call failed");

  // The marker file is the source of truth for the on/off toggle: it survives
  // /reload and restarts, unlike an in-memory flag.
  let enabled = !existsSync(DISABLED_MARKER);
  let last: LastRoute | undefined;
  let alwaysAllow = false;
  // A misconfiguration is reported once per session instance; after that
  // /task-router, /router-config and /router-check still say what is wrong.
  let configurationReported = false;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `task-router: ${enabled ? selectionLabel(selection) : "disabled (use /task-router on to enable)"}`,
      "info",
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Disabled: do nothing — no classify, no Jev call, no setModel, no notify.
    if (!enabled) return;

    const prompt = event.prompt ?? "";

    // Built-in slash commands are dispatched before this hook, and registered
    // extension/prompt commands are matched here too, so neither is ever routed.
    // Skill and prompt-template commands (/skill:..., /template ...) are expanded
    // by pi before before_agent_start fires, so they are out of scope for this
    // guard — only a literal slash-looking prompt can match it.
    if (isCommandLike(pi, prompt)) return;

    if (selection.kind === "misconfigured") {
      if (!configurationReported) {
        configurationReported = true;
        ctx.ui.notify(`router: ${selection.reason}`, "error");
      }
      return;
    }

    // Image-only turn: no text signal to classify, and vision support is a
    // property of the current model, not of a tier.
    if (!prompt.trim() && event.images?.length) return;

    if (STEP0_PROOF) {
      const model = ctx.modelRegistry.find(STEP0_MODEL.provider, STEP0_MODEL.modelId);
      if (!model) {
        ctx.ui.notify(`step0: ${formatRef(STEP0_MODEL)} is not in this machine's catalogue`, "error");
        return;
      }
      const ok = await pi.setModel(model);
      ctx.ui.notify(
        `step0: ${formatRef(STEP0_MODEL)} -> ${ok ? "active for this turn" : "refused, no auth"}`,
        ok ? "info" : "error",
      );
      return;
    }

    // Classify. A Jev failure degrades to the heuristic and says so; it never
    // blocks the turn and never silently produces a different kind of decision.
    let outcome: ProviderOutcome;
    let source = selection.provider.name;

    try {
      outcome = await selection.provider.classify(prompt);
    } catch (error) {
      if (source === "fake") {
        ctx.ui.notify(`router: classification failed - ${clip(String(error), 120)}`, "error");
        return;
      }
      const reason = clip(error instanceof Error ? error.message : String(error), 120);
      ctx.ui.notify(`router: jev unavailable, using heuristics - ${reason}`, "warning");
      outcome = await fallback.classify(prompt);
      source = "fake";
    }

    const decision = applyPolicy(outcome.decision);
    const summary = describe(decision);

    // ask_human / unclear / needs_human / too unsure: never guess a model.
    if (!routableTier(decision.model_tier)) {
      ctx.ui.notify(
        `router: not routing (${summary}, ${decision.rationale ?? "no signal"}) - clarify the task or pick a model with /model`,
        "warning",
      );
      last = { prompt, decision, outcome: "ask_human", source, detail: outcome.detail };
      return;
    }

    const model = resolveTierModel(ctx.modelRegistry, decision.model_tier);
    if (!model) {
      ctx.ui.notify(
        `router: no usable model for ${decision.model_tier} - check TIER_MODELS in policy.ts, models.json and auth`,
        "error",
      );
      last = { prompt, decision, outcome: "unresolved", source, detail: outcome.detail };
      return;
    }

    const target = `${model.provider}/${model.id}`;
    const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

    if (active === target) {
      ctx.ui.notify(`routed: ${summary} -> ${target} (already active)`, "info");
      last = { prompt, decision, outcome: target, source, detail: outcome.detail };
      return;
    }

    if (!alwaysAllow) {
      const confirm = await confirmModelSwitch(ctx, decision, model);
      if (confirm === "declined") {
        ctx.ui.notify(`router: model change declined - staying on ${active ?? "none"}`, "warning");
        last = { prompt, decision, outcome: `declined ${target}`, source, detail: outcome.detail };
        return;
      }
      if (confirm === "always") alwaysAllow = true;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(
        `router: setModel refused ${target} (auth not configured); model left on ${active ?? "none"}`,
        "error",
      );
      last = { prompt, decision, outcome: `refused ${target}`, source, detail: outcome.detail };
      return;
    }

    // Footer marker survives until the next routed prompt; useful when testing.
    ctx.ui.setStatus("task-router", `${decision.task_kind}/${decision.complexity} - ${decision.model_tier}`);
    ctx.ui.notify(`routed: ${summary} -> ${target}`, "info");
    last = { prompt, decision, outcome: target, source, detail: outcome.detail };
  });

  pi.registerCommand("router", {
    description: "Show the last task-router decision and where it landed",
    handler: async (_args, ctx) => {
      if (!last) {
        ctx.ui.notify("router: nothing routed yet in this session instance", "info");
        return;
      }
      const d = last.decision;
      ctx.ui.notify(
        `router: "${clip(last.prompt)}" -> ${describe(d)} | conf ${(d.confidence ?? 0).toFixed(2)} | repo_map ${
          d.needs_repo_map ? "yes" : "no"
        } | ${last.outcome}`,
        "info",
      );
      ctx.ui.notify(`  via ${last.source} · ${last.detail}`, "info");
    },
  });

  pi.registerCommand("router-config", {
    description: "Show the active classifier, credentials and thresholds",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`router: classifier = ${selectionLabel(selection)}`, "info");
      ctx.ui.notify(
        `  TYPESAFE_API_KEY ${maskSecret(CONFIG.apiKey)} · base ${CONFIG.baseUrl} · model ${CONFIG.model}`,
        "info",
      );
      ctx.ui.notify(
        `  floors: unsure < ${UNSURE_FLOOR} -> ask · confidence < ${CONFIDENCE_FLOOR} -> balanced · noul >= ${NOUL_THRESHOLD}`,
        "info",
      );
      ctx.ui.notify(
        `  confirm gate: ${alwaysAllow ? "off (always-allow this session)" : "on (expensive switches only, TUI, 30s timeout)"}`,
        "info",
      );

      const resolved = (["fast_cheap", "balanced", "frontier"] as const)
        .map((tier) => {
          const model = resolveTierModel(ctx.modelRegistry, tier);
          return `${tier}=${model ? `${model.provider}/${model.id}` : "UNRESOLVED"}`;
        })
        .join(" · ");
      ctx.ui.notify(`  resolved now: ${resolved}`, "info");
      ctx.ui.notify(
        `  allowlists: ${(["fast_cheap", "balanced", "frontier"] as const)
          .map((tier) => `${tier}[${TIER_MODELS[tier].length}]`)
          .join(" ")}`,
        "info",
      );
    },
  });

  pi.registerCommand("task-router", {
    description: "Toggle the router: /task-router on|off, or bare to show state",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        if (existsSync(DISABLED_MARKER)) unlinkSync(DISABLED_MARKER);
        enabled = true;
        alwaysAllow = false;
        ctx.ui.notify("task-router enabled", "info");
        return;
      }

      if (arg === "off") {
        writeFileSync(DISABLED_MARKER, "", "utf8");
        enabled = false;
        ctx.ui.notify("task-router disabled - model will stay wherever you leave it", "warning");
        return;
      }

      if (arg === "") {
        ctx.ui.notify(
          `task-router is ${enabled ? `enabled (${selectionLabel(selection)})` : "disabled - /task-router on to enable"}`,
          "info",
        );
        return;
      }

      ctx.ui.notify("usage: /task-router on | off  (bare shows state)", "warning");
    },
  });

  pi.registerCommand("router-check", {
    description: "Run fixtures.jsonl through classify + applyPolicy; --jev for the live API, --fake to force the heuristic",
    handler: async (args, ctx) => {
      const useJev = /--jev\b/.test(args);
      const useFake = /--fake\b/.test(args);

      if (useJev && useFake) {
        ctx.ui.notify("router-check: --jev and --fake are mutually exclusive", "warning");
        return;
      }

      let provider: ClassifierProvider;
      let label: string;

      if (useJev) {
        if (!CONFIG.apiKey) {
          ctx.ui.notify("router-check: --jev needs TYPESAFE_API_KEY", "error");
          return;
        }
        provider = createJevProvider({
          apiKey: CONFIG.apiKey,
          baseUrl: CONFIG.baseUrl,
          model: CONFIG.model,
          timeoutMs: CONFIG.timeoutMs,
          maxChars: CONFIG.maxChars,
          cacheSize: 0,
        });
        label = `jev ${CONFIG.model}`;
      } else if (useFake) {
        // The heuristic fixtures stay reachable when the configured classifier is
        // unusable, which is exactly when running them is worth something.
        provider = fakeProvider("forced by --fake");
        label = "heuristic (forced by --fake)";
      } else if (selection.kind === "misconfigured") {
        ctx.ui.notify(`router-check: ${selection.reason} (or --fake for the heuristic fixtures)`, "error");
        return;
      } else {
        provider = selection.provider;
        label = selection.label;
      }

      let fixtures: Fixture[];
      try {
        fixtures = loadFixtures();
      } catch (error) {
        ctx.ui.notify(`router-check: cannot read fixtures.jsonl (${String(error)})`, "error");
        return;
      }

      const startedAt = Date.now();
      let passed = 0;
      const failures: string[] = [];
      const notes: string[] = [];

      for (const fixture of fixtures) {
        let outcome: ProviderOutcome;
        try {
          outcome = await provider.classify(fixture.prompt);
        } catch (error) {
          failures.push(`"${clip(fixture.prompt, 40)}" -> provider failed: ${clip(String(error), 120)}`);
          continue;
        }

        const decision = applyPolicy(outcome.decision);
        const tierOk = decision.model_tier === fixture.expect_tier;
        const kindOk = decision.task_kind === fixture.expect_kind;
        const complexityOk = decision.complexity === fixture.expect_complexity;

        if (!useJev) {
          // Heuristic regression: deterministic, so all three must match.
          if (tierOk && kindOk && complexityOk) {
            passed += 1;
          } else {
            failures.push(
              `"${clip(fixture.prompt, 40)}" -> ${describe(decision)} (want ${fixture.expect_kind}/${fixture.expect_complexity}/${fixture.expect_tier}) · ${outcome.detail}`,
            );
          }
        } else {
          // Live classifier: the tier is what the router acts on. Kind and
          // complexity disagreements are surfaced as tuning notes, not failures.
          if (tierOk) passed += 1;
          else
            failures.push(
              `"${clip(fixture.prompt, 40)}" -> ${describe(decision)} (want tier ${fixture.expect_tier}) · ${outcome.detail}`,
            );
          if (!kindOk || !complexityOk) {
            notes.push(
              `  "${clip(fixture.prompt, 40)}" kind ${decision.task_kind}(want ${fixture.expect_kind}) complexity ${decision.complexity}(want ${fixture.expect_complexity})`,
            );
          }
        }
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      ctx.ui.notify(
        `router-check: ${passed}/${fixtures.length} ${useJev ? "tiers" : "fixtures"} passed via ${label} in ${seconds}s`,
        failures.length > 0 ? "warning" : "info",
      );
      if (useJev && failures.length > 0) {
        ctx.ui.notify(
          "  with --jev a tier mismatch means the question wording and the expectation disagree; read the probabilities before changing either",
          "info",
        );
      }
      for (const failure of failures) {
        ctx.ui.notify(`  ${failure}`, "warning");
      }
      if (useJev) {
        for (const note of notes) {
          ctx.ui.notify(`${note}`, "info");
        }
      }
    },
  });
}
