/**
 * task-router — REVIEW THIS FILE FIRST.
 *
 * These are the only questions sent to Jev, and the only place the option names
 * live. TypeSafe's own guidance is that humans should review the questions and
 * the thresholds, and that both belong in a single, findable file. Thresholds
 * live in policy.ts; the questions live here.
 *
 * Two rules the docs are explicit about, both of which this file obeys:
 *   - option names AND their descriptions are sent to the model, so every
 *     description must separate that option from its neighbours
 *   - one call carries every question; questions are evaluated in parallel and
 *     cost almost no extra latency
 *
 * Option names are the wire format. Renaming `bugfix` to `bug_fix` changes the
 * request, the response, and the validation in jev.ts at once, because the
 * allowed keys are derived from the criteria records below.
 */

import type { Complexity, TaskKind } from "../schema.ts";

/**
 * Keys are TaskKind, so adding a kind to schema.ts without describing it here
 * is a type error rather than a silently unreachable classification.
 */
const TASK_KIND_CRITERIA: Record<TaskKind, string> = {
  bugfix:
    "Diagnose or repair behaviour that is broken: a crash, an error, a wrong result, a failing or flaky test run reported as a defect.",
  feature:
    "Add capability that does not exist yet, or extend existing capability: a new endpoint, a new screen, a new option, a new integration.",
  refactor:
    "Change the structure of existing code without changing what it does: extract, rename, deduplicate, simplify, reorganise, remove dead code.",
  tests:
    "Primarily about tests: write them, repair them, raise coverage, add fixtures or mocks, make a suite run.",
  docs:
    "Primarily about prose or comments: README, guides, changelog, API docs, docstrings, code comments, a tutorial.",
  security:
    "Authentication, authorisation, permissions, sessions, tokens, secrets, or a specific vulnerability class (XSS, CSRF, SSRF, SQL injection, IDOR), including prompts that merely mention a sensitive area while asking for a fix.",
  unclear:
    "There is not enough information to tell what is being asked: no verb, no subject, or a request for an opinion rather than a change.",
};

const COMPLEXITY_CRITERIA: Record<Complexity, string> = {
  S: "One file or one small function, no design decisions, answerable from local context alone.",
  M: "A handful of files or one module, some design choice involved, needs context beyond the immediately edited code.",
  L: "Cross-cutting, multi-module or architectural: touches shared interfaces, migrations, concurrency, or several subsystems, and getting the shape wrong is expensive.",
};

/** Derived from the records above, so the wire format and the validation cannot drift apart. */
export const TASK_KIND_OPTIONS = Object.keys(TASK_KIND_CRITERIA) as TaskKind[];
export const COMPLEXITY_OPTIONS = Object.keys(COMPLEXITY_CRITERIA) as Complexity[];

export const TASK_KIND_QUESTION = "task_kind";
export const COMPLEXITY_QUESTION = "complexity";
export const NEEDS_REPO_MAP_QUESTION = "needs_repo_map";
export const NEEDS_HUMAN_QUESTION = "needs_human";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type JevQuestion = ChoiceQuestion | NoulQuestion;

/**
 * The request's `questions` map, verbatim. Four questions in one call: two
 * choices that land straight in the Decision, and two yes/no questions that
 * policy turns into an ask-human verdict.
 *
 * Noul answers carry no confidence (per the API), so neither of the noul
 * questions can influence Decision.confidence. That is deliberate: confidence
 * describes how sure the model is about *which* kind and size this is, and
 * conflating it with a yes/no probability would make the floor meaningless.
 */
export const JEV_QUESTIONS: Record<string, JevQuestion> = {
  [TASK_KIND_QUESTION]: {
    type: "choice",
    instructions: "What kind of engineering work does this request ask for? Pick the single closest option.",
    criteria: TASK_KIND_CRITERIA,
  },
  [COMPLEXITY_QUESTION]: {
    type: "choice",
    instructions: "How much scope and design judgement does this request carry? Judge the work implied, not the length of the message.",
    criteria: COMPLEXITY_CRITERIA,
  },
  [NEEDS_REPO_MAP_QUESTION]: {
    type: "noul",
    instructions:
      "Answering this requires reading code from more than one file, or discovering where the relevant code lives before it can be changed.",
    criteria: {
      true: "The answer depends on code or structure beyond a single file that is already identified.",
      false: "A single, already-identified file or snippet contains everything needed.",
    },
  },
  [NEEDS_HUMAN_QUESTION]: {
    type: "noul",
    instructions:
      "Does this request ask for an action an autonomous agent should not take without explicit human approval: a destructive or irreversible operation (deleting data, dropping tables, removing access, rewriting git history, deploying to production), or a decision that is the human's to make (product direction, spending, legal)?",
    criteria: {
      true: "Carrying this out autonomously could cause irreversible harm, or oversteps what an agent may decide on its own.",
      false: "The change is safe to attempt and iterate; a mistake is recoverable and any ambiguity can be resolved by asking.",
    },
  },
};
