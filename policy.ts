/**
 * task-router — tier policy.
 *
 * Three responsibilities, all of them pure:
 *   1. applyPolicy(): classifier output -> final tier (no model ids involved).
 *   2. parseTierModels(): TASK_ROUTER_TIERS -> the effective tier -> allowlist table.
 *   3. resolveTierModel(): tier -> the first model from that tier's allowlist that
 *      exists in the caller's registry and has configured auth.
 *
 * Nothing here invents a provider: every candidate is validated through the lookup
 * passed in (find + hasConfiguredAuth) at call time. This module imports no pi types
 * at all, which is why the policy is testable without a registry, a key, or a network.
 */

import type { Decision, ModelTier, TaskKind } from "./schema.ts";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type RoutableTier = Exclude<ModelTier, "ask_human">;

/** The three tiers a prompt can actually be routed to, in ascending capability. */
export const ROUTABLE_TIERS = ["fast_cheap", "balanced", "frontier"] as const satisfies readonly RoutableTier[];

/** The effective tier -> allowlist table; `TIER_MODELS` unless overridden. */
export type TierModels = Record<RoutableTier, ModelRef[]>;

/** Ascending capability. Used for "at least this tier" bumps. */
const TIER_RANK: Record<ModelTier, number> = {
  fast_cheap: 0,
  balanced: 1,
  frontier: 2,
  ask_human: 3,
};

/**
 * Thresholds. TypeSafe's docs ask for these to be reviewable in one place, and
 * they are the knobs you actually tune: the questions in providers/jev-questions.ts
 * decide what the classifier sees, these decide what the router does with it.
 *
 * Both floors are on Decision.confidence, which the Jev provider sets to the
 * task_kind choice's confidence (see providers/jev.ts for why complexity
 * confidence is deliberately not folded in). A low kind confidence means the
 * classifier cannot tell which kind of task this is, which is exactly the
 * situation where routing on a guess is the wrong move.
 */

/** Below this, never route to the cheap tier. */
export const CONFIDENCE_FLOOR = 0.7;

/**
 * Below this the classification itself is not trustworthy enough to act on.
 * The docs' "low confidence: do not act, route to a human" band.
 */
export const UNSURE_FLOOR = 0.5;

/** A noul answer counts as true at or above this probability. */
export const NOUL_THRESHOLD = 0.5;

/**
 * The tier a task kind proposes before any bump. The single kind -> tier table:
 * both classifiers emit Decision.model_tier from here, so the heuristic and Jev
 * cannot disagree about what a task kind means, only about which kind this is.
 */
export const BASE_TIER: Record<TaskKind, ModelTier> = {
  bugfix: "fast_cheap",
  tests: "fast_cheap",
  docs: "fast_cheap",
  refactor: "balanced",
  feature: "balanced",
  security: "frontier",
  unclear: "ask_human",
};

function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Ordered allowlist per tier. First usable entry wins. These are the *defaults*:
 * `TASK_ROUTER_TIERS` overrides them at load time (see parseTierModels), because
 * whether an id exists is a property of your model catalogue, not of the router.
 *
 * Deliberately collapsed to two models here:
 *   - fast_cheap           -> deepseek/deepseek-v4-flash
 *   - balanced + frontier  -> deepseek/deepseek-v4-pro
 *
 * frontier shares its entry with balanced on purpose: there is no third model in
 * the rotation, and the tier distinction still matters to the policy — "security ->
 * at least frontier" is what guarantees a security prompt never lands on the flash
 * model, even though the model it lands on is the same one balanced uses.
 *
 * To widen the rotation, append entries here or set `TASK_ROUTER_TIERS`; entries
 * that do not resolve (or have no auth) are skipped at call time, never guessed at.
 */
export const TIER_MODELS: TierModels = {
  fast_cheap: [
    { provider: "deepseek", modelId: "deepseek-v4-flash" },
  ],
  balanced: [
    { provider: "deepseek", modelId: "deepseek-v4-pro" },
  ],
  frontier: [
    { provider: "deepseek", modelId: "deepseek-v4-pro" },
  ],
};

/**
 * Final tier for a classifier decision. Order matters:
 *
 *   1. security       -> at least frontier (never anything cheaper)
 *   2. complexity L + fast_cheap -> balanced
 *   3. ask_human / unclear / needs_human -> ask_human, UNLESS the tier is already
 *      frontier (caller must not setModel)
 *   4. confidence < UNSURE_FLOOR -> ask_human, unless already frontier
 *   5. confidence < CONFIDENCE_FLOOR -> at least balanced
 *
 * The frontier exceptions in rules 3 and 4 exist because frontier is terminal:
 * once a security classification has claimed it, nothing knocks it off. ask_human
 * does NOT stop the turn — it only declines to change the model — so letting
 * needs_human (or low confidence) demote a security prompt to ask_human would
 * leave the security work running on whatever model was already active, which is
 * exactly the one outcome this policy exists to prevent.
 */
export function applyPolicy(decision: Decision): Decision {
  const confidence = decision.confidence ?? 0;
  let tier = decision.model_tier;

  if (decision.task_kind === "security") {
    tier = maxTier(tier, "frontier");
  }

  if (decision.complexity === "L" && tier === "fast_cheap") {
    tier = "balanced";
  }

  const askHuman = decision.task_kind === "unclear" || decision.needs_human || tier === "ask_human";
  if (tier !== "frontier" && askHuman) {
    return { ...decision, model_tier: "ask_human" };
  }

  if (confidence < UNSURE_FLOOR && tier !== "frontier") {
    return { ...decision, model_tier: "ask_human" };
  }

  if (confidence < CONFIDENCE_FLOOR) {
    tier = maxTier(tier, "balanced");
  }

  return { ...decision, model_tier: tier };
}

export function routableTier(tier: ModelTier): tier is RoutableTier {
  return tier !== "ask_human";
}

function isRoutableTier(key: string): key is RoutableTier {
  return (ROUTABLE_TIERS as readonly string[]).includes(key);
}

/**
 * Parse `TASK_ROUTER_TIERS`, the env override for the tier -> allowlist table.
 *
 * JSON object, partially or fully specified; omitted tiers keep their default:
 *   {"fast_cheap":["anthropic/claude-haiku-4-5"],"balanced":["anthropic/claude-sonnet-4-5"]}
 *
 * This exists because the shipped defaults are one machine's catalogue: model ids
 * are a property of *your* `pi --list-models`, not of the router. Everything here
 * is validated up front and reported as one actionable error, because a typo that
 * silently resolves nothing turns into a failed route on every prompt.
 */
export function parseTierModels(raw: string | undefined): { tiers: TierModels } | { error: string } {
  if (raw === undefined || raw.trim() === "") return { tiers: TIER_MODELS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `TASK_ROUTER_TIERS is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: 'TASK_ROUTER_TIERS must be a JSON object, e.g. {"fast_cheap":["provider/modelId"]}' };
  }

  const tiers: TierModels = {
    fast_cheap: [...TIER_MODELS.fast_cheap],
    balanced: [...TIER_MODELS.balanced],
    frontier: [...TIER_MODELS.frontier],
  };

  for (const [key, value] of Object.entries(parsed)) {
    if (!isRoutableTier(key)) {
      return { error: `TASK_ROUTER_TIERS has unknown tier "${key}" (expected ${ROUTABLE_TIERS.join(", ")})` };
    }
    if (!Array.isArray(value)) {
      return { error: `TASK_ROUTER_TIERS.${key} must be an array of "provider/modelId" strings` };
    }
    if (value.length === 0) {
      return { error: `TASK_ROUTER_TIERS.${key} is empty; omit the key instead to keep the default` };
    }

    const refs: ModelRef[] = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        return { error: `TASK_ROUTER_TIERS.${key}[${index}] must be a "provider/modelId" string` };
      }
      const ref = entry.trim();
      const slash = ref.indexOf("/");
      if (slash < 1 || slash === ref.length - 1 || /\s/.test(ref)) {
        return { error: `TASK_ROUTER_TIERS.${key}[${index}] must look like "provider/modelId" (got "${ref}")` };
      }
      refs.push({ provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) });
    }
    tiers[key] = refs;
  }

  return { tiers };
}

export function formatRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

/**
 * The minimum a model has to expose to be ranked or resolved. Structural: the
 * registry's real `Model` satisfies it, and so does a two-field test double.
 */
export interface ModelHandle {
  provider: string;
  id: string;
}

/** The cheapest tier whose allowlist contains this model, if any. */
function tierOf(model: ModelHandle, tiers: TierModels): RoutableTier | undefined {
  const key = `${model.provider}/${model.id}`;
  return ROUTABLE_TIERS.find((tier) => tiers[tier].some((ref) => formatRef(ref) === key));
}

/**
 * True when the target sits in a higher tier than the current model.
 *
 * Cost order is read off the tier table rather than a separate price table. That is
 * the point: `ROUTABLE_TIERS` is already declared in ascending capability, and a
 * second table keyed by `provider/modelId` made the *gateway* part of a model's
 * identity. Same model, different reseller, and the old table had no entry — it
 * failed closed, so the gate prompted on an upgrade it should have recognised, and
 * the only fix was a code change. Deriving the order means an override ranks
 * correctly with nothing extra to keep in sync.
 *
 * Two consequences worth knowing:
 *
 *   - models in the *same* tier are not a price step, so the tier table is also the
 *     cost knob: a model that costs more than its tier peers wants its own tier,
 *     not a rank row;
 *   - a target in no tier at all still fails closed. It cannot be proven cheap, so
 *     the switch is confirmed rather than waved through, which is what stops a
 *     widened rotation from silently skipping the gate.
 *
 * A current model in no tier — you switched by hand — ranks as the cheapest tier.
 * There is no evidence it was expensive, and the target's tier is what justifies
 * asking.
 */
export function isMoreExpensive(
  from: ModelHandle | undefined,
  to: ModelHandle,
  tiers: TierModels = TIER_MODELS,
): boolean {
  const toTier = tierOf(to, tiers);
  if (toTier === undefined) return true;

  const fromRank = from ? TIER_RANK[tierOf(from, tiers) ?? "fast_cheap"] : TIER_RANK.fast_cheap;
  return TIER_RANK[toTier] > fromRank;
}

/**
 * The only two registry capabilities this module needs. Structural on purpose: the
 * real `ModelRegistry` satisfies it, and a test can pass a two-method stub instead
 * of faking eighteen methods.
 */
export interface ModelLookup<TModel extends ModelHandle> {
  find(provider: string, modelId: string): TModel | undefined;
  hasConfiguredAuth(model: TModel): boolean;
}

/**
 * First allowlist entry that exists in the registry and has usable auth.
 * Returns undefined when this machine cannot serve the tier at all; the caller
 * must then leave the current model untouched.
 *
 * Generic in the model type so the caller gets back whatever its own registry
 * returns (index.ts needs the full `Model` for `pi.setModel`), while tests can
 * work with a bare `{ provider, id }`.
 *
 * `tiers` is the effective table: `TIER_MODELS` by default, or the caller's
 * `TASK_ROUTER_TIERS` override.
 */
export function resolveTierModel<TModel extends ModelHandle>(
  registry: ModelLookup<TModel>,
  tier: RoutableTier,
  tiers: TierModels = TIER_MODELS,
): TModel | undefined {
  for (const ref of tiers[tier]) {
    const model = registry.find(ref.provider, ref.modelId);
    if (!model) continue;
    if (!registry.hasConfiguredAuth(model)) continue;
    return model;
  }
  return undefined;
}
