/**
 * task-router — shared vocabulary.
 *
 * The classifier emits ONLY these fields. It never emits a provider or a model id:
 * that mapping lives in policy.ts, so a bad classification can pick the wrong tier,
 * never an arbitrary model.
 */

export type TaskKind = "bugfix" | "feature" | "refactor" | "tests" | "docs" | "security" | "unclear";

export type Complexity = "S" | "M" | "L";

export type ModelTier = "fast_cheap" | "balanced" | "frontier" | "ask_human";

export interface Decision {
  task_kind: TaskKind;
  complexity: Complexity;
  model_tier: ModelTier;
  needs_repo_map?: boolean;
  needs_human?: boolean;
  confidence?: number;
  /** Local-only, for notify/debug. Never read by routing or by applyPolicy. */
  rationale?: string;
}
