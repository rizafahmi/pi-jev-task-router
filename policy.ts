/**
 * task-router — tier policy (Step 2).
 *
 * Two responsibilities:
 *   1. applyPolicy(): classifier output -> final tier (no model ids involved).
 *   2. resolveTierModel(): tier -> the first model from that tier's allowlist that
 *      actually exists in THIS machine's registry and has configured auth.
 *
 * Nothing here invents a provider: every candidate is validated through
 * ModelRegistry.find() + ModelRegistry.hasConfiguredAuth() at call time.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Decision, ModelTier, TaskKind } from "./schema.ts";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type RoutableTier = Exclude<ModelTier, "ask_human">;

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
 * Ordered allowlist per tier. First usable entry wins.
 *
 * Deliberately collapsed to two models on this machine:
 *   - fast_cheap           -> deepseek/deepseek-v4-flash
 *   - balanced + frontier  -> deepseek/deepseek-v4-pro
 *
 * frontier shares its entry with balanced on purpose: there is no third model in
 * the rotation, and the tier distinction still matters to the policy — "security ->
 * at least frontier" is what guarantees a security prompt never lands on the flash
 * model, even though the model it lands on is the same one balanced uses.
 *
 * To widen the rotation again, append entries here; entries that do not resolve
 * (or have no auth) are skipped at call time, never guessed at.
 */
export const TIER_MODELS: Record<RoutableTier, ModelRef[]> = {
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

export function formatRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

/**
 * Price rank per model, used by the confirm gate to decide whether a switch is
 * "more expensive". With the current two-model rotation, flash is 0 and pro is 1.
 * An absent/unknown model ranks as cheapest (0), so a switch to the expensive
 * model is confirmed and a switch to the cheap one never is. To widen the
 * rotation, add entries here in ascending price order.
 */
export const MODEL_PRICE_RANK: Record<string, number> = {
  "deepseek/deepseek-v4-flash": 0,
  "deepseek/deepseek-v4-pro": 1,
};

interface ModelHandle {
  provider: string;
  id: string;
}

function priceRank(model: ModelHandle | undefined): number {
  if (!model) return 0;
  return MODEL_PRICE_RANK[`${model.provider}/${model.id}`] ?? 0;
}

/**
 * True when the target is pricier than the current model.
 *
 * An unknown target fails closed: with no price entry it cannot be proven cheap,
 * so the switch is treated as expensive and confirmed. This guards against
 * widening TIER_MODELS without adding the matching MODEL_PRICE_RANK entry — the
 * gate would otherwise silently skip confirmation for the new model.
 */
export function isMoreExpensive(from: ModelHandle | undefined, to: ModelHandle): boolean {
  const toRank = MODEL_PRICE_RANK[`${to.provider}/${to.id}`];
  if (toRank === undefined) return true;
  return toRank > priceRank(from);
}

export type ResolvedModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

/**
 * First allowlist entry that exists in the registry and has usable auth.
 * Returns undefined when this machine cannot serve the tier at all; the caller
 * must then leave the current model untouched.
 */
export function resolveTierModel(registry: ModelRegistry, tier: RoutableTier): ResolvedModel | undefined {
  for (const ref of TIER_MODELS[tier]) {
    const model = registry.find(ref.provider, ref.modelId);
    if (!model) continue;
    if (!registry.hasConfiguredAuth(model)) continue;
    return model;
  }
  return undefined;
}
