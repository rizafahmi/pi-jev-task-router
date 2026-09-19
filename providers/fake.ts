/**
 * task-router — Step 1 fake classifier.
 *
 * Keyword heuristics only. No network, no Jev, no model calls.
 * Precision is deliberately biased toward safety: a false "security" sends work to
 * frontier, which is the cheap mistake; a false "bugfix" sends it to fast_cheap.
 */

import type { Complexity, Decision, TaskKind } from "../schema.ts";
import { BASE_TIER } from "../policy.ts";
import type { ClassifierProvider, ProviderOutcome } from "./types.ts";

interface Rule {
  pattern: RegExp;
  kind: TaskKind;
  complexity: Complexity;
  confidence: number;
  rationale: string;
}

/**
 * Evaluated top to bottom; first match wins. Ordering rationale:
 *   - security ahead of bugfix, so "fix the IDOR" is security, not bugfix
 *   - docs ahead of bugfix, so "fix the error in the README" is docs
 *   - tests ahead of bugfix, so "add failing tests for X" is tests
 *
 * Rules carry no tier: Decision.model_tier comes from BASE_TIER in policy.ts, the
 * same table the Jev provider uses, so both classifiers agree on what a task kind
 * is worth and can only disagree about which kind they are looking at.
 */
const RULES: Rule[] = [
  {
    pattern:
      /\b(auth|authenticate|authentication|authoriz\w*|login|logout|session|token|secret|credential|credentials|security|secure|xss|csrf|ssrf|sqli|sql injection|idor|injection|inject|vulnerab\w*|exploit|permission|permissions|rbac|encrypt|decrypt|hash|password|rate.?limit)\b/i,
    kind: "security",
    complexity: "L",
    confidence: 0.9,
    rationale: "security keyword",
  },
  {
    pattern: /\b(test|tests|spec|specs|coverage|exunit|vitest|jest|pytest|fixture|fixtures|mock|mocks)\b/i,
    kind: "tests",
    complexity: "S",
    confidence: 0.9,
    rationale: "test keyword",
  },
  {
    pattern: /\b(doc|docs|documentation|readme|comment|comments|changelog|jsdoc|moduledoc|typedoc|guide|tutorial)\b/i,
    kind: "docs",
    complexity: "S",
    confidence: 0.9,
    rationale: "docs keyword",
  },
  {
    pattern: /\b(refactor|refactoring|cleanup|clean up|restructure|simplify|rename|extract|dedupe|deduplicate|tidy|dead code)\b/i,
    kind: "refactor",
    complexity: "M",
    confidence: 0.85,
    rationale: "refactor keyword",
  },
  {
    pattern:
      /\b(fix|fixes|fixed|bug|bugs|error|errors|crash|crashes|broken|regress(?:ion|ed)?|500|stack ?trace|fail|fails|failing|failure|throw|throws|exception|panic|hotfix)\b/i,
    kind: "bugfix",
    complexity: "S",
    confidence: 0.9,
    rationale: "bug keyword",
  },
];

/** Explicit vagueness, checked only when no keyword rule matched. */
const VAGUE_RE =
  /^(help|hi|hey|hello|hmm+|idk|thoughts|what do you think|not sure|you decide|do it|go|ok|okay|anything|please)\b/i;

/** Scope markers that escalate S/M to L; L + fast_cheap is then lifted by policy.ts. */
const BIG_SCOPE_RE =
  /\b(everywhere|all files|across the codebase|whole (repo|codebase|project)|project-?wide|multi-?file|end-?to-?end|large|big|major)\b/i;

function unclear(rationale: string, confidence: number): Decision {
  return {
    task_kind: "unclear",
    complexity: "S",
    model_tier: BASE_TIER.unclear,
    needs_repo_map: false,
    needs_human: true,
    confidence,
    rationale,
  };
}

export function classify(prompt: string): Decision {
  const text = prompt.trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return unclear("empty prompt", 0.2);
  }

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;

    const escalated = BIG_SCOPE_RE.test(text) && rule.complexity !== "L";
    const needsRepoMap = rule.kind === "security" || rule.kind === "refactor" || escalated;

    return {
      task_kind: rule.kind,
      complexity: escalated ? "L" : rule.complexity,
      model_tier: BASE_TIER[rule.kind],
      needs_repo_map: needsRepoMap,
      confidence: rule.confidence,
      rationale: escalated ? `${rule.rationale} + large scope` : rule.rationale,
    };
  }

  if (VAGUE_RE.test(text)) {
    return unclear("vague phrasing", 0.3);
  }

  if (words.length < 5) {
    return unclear("short prompt, no task signal", 0.4);
  }

  return {
    task_kind: "feature",
    complexity: "M",
    model_tier: BASE_TIER.feature,
    needs_repo_map: true,
    needs_human: false,
    confidence: 0.6,
    rationale: "no keyword matched",
  };
}

/**
 * The heuristic as a ClassifierProvider, used when TYPESAFE_API_KEY is absent and
 * as the fallback when a Jev call fails. Detail strings say which, so a degraded
 * turn is visible in `notify` and `/router` rather than silently different.
 */
export function fakeProvider(reason: string): ClassifierProvider {
  return {
    name: "fake",
    async classify(prompt: string): Promise<ProviderOutcome> {
      const decision = classify(prompt);
      return { decision, detail: `heuristic (${reason}): ${decision.rationale ?? "match"}` };
    },
  };
}
