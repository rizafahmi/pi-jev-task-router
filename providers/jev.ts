/**
 * task-router — the real classifier: Jev, on TypeSafe's System One endpoint.
 *
 * Wire contract, from https://docs.typesafe.ai/api:
 *
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <API_KEY>
 *   { state, model, questions: { <id>: { type, instructions, criteria } } }
 *   -> { model, answers: { <id>: ... }, usage: { input_tokens, output_tokens } }
 *
 * A choice answer carries { choice, probabilities, confidence }; a noul answer
 * carries { noul } and no confidence. Both choices are asked in the same request
 * as the two nouls, because the docs are explicit that questions are evaluated in
 * parallel and cost almost no extra latency.
 *
 * Mapping rules, and why:
 *   - Decision.confidence is the task_kind choice's confidence, not a combination
 *     of both axes. The docs' intent-routing pattern gates on the intent answer
 *     and uses complexity only for escalation, never as a veto on the whole
 *     route. Complexity (S/M/L) is genuinely ambiguous from a one-line prompt,
 *     so its confidence is systematically low even when the kind is read at 1.0;
 *     folding it in would send nearly every prompt to ask_human.
 *   - An unreadable answer (unknown option name, missing confidence, missing noul)
 *     throws rather than guessing, so the router degrades to heuristics visibly.
 *     A wrong-but-confident classification is the one outcome worth avoiding.
 *   - responses are cached in-process by (model, state), so a re-sent prompt does
 *     not pay for the same judgement twice.
 */

import type { Complexity, Decision, TaskKind } from "../schema.ts";
import { BASE_TIER, NOUL_THRESHOLD } from "../policy.ts";
import {
  COMPLEXITY_OPTIONS,
  COMPLEXITY_QUESTION,
  JEV_QUESTIONS,
  NEEDS_HUMAN_QUESTION,
  NEEDS_REPO_MAP_QUESTION,
  TASK_KIND_OPTIONS,
  TASK_KIND_QUESTION,
} from "./jev-questions.ts";
import type { ClassifierProvider, ProviderOutcome } from "./types.ts";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/**
 * A key read from the environment: `undefined` when absent **or blank**.
 *
 * `TYPESAFE_API_KEY= ` — a stray space in a shell rc, or an unset variable
 * expanded into a config file — is not a key. Treating it as one builds a Jev
 * provider that 403s on every call, so the router reports its classifier as
 * "jev" while actually degrading to the heuristic on every prompt. Blank is
 * absent, which is the state the rest of the code already handles.
 */
export function normalizeApiKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The API rejected the credential: the key is wrong, expired, or revoked.
 *
 * Deliberately distinct from a transient failure. A 401/403 will not fix itself
 * mid-session (the key is read once, at load), so retrying it per prompt only buys
 * a round trip and a repeat warning. The router treats one of these as a setup
 * error and turns itself off.
 */
export class JevAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`jev rejected the API key (HTTP ${status})`);
    this.name = "JevAuthError";
    this.status = status;
  }
}

export function isJevAuthError(error: unknown): error is JevAuthError {
  return error instanceof JevAuthError;
}

/**
 * Map a non-ok response to the error to throw. Auth statuses get their own type so
 * the caller can tell "your key is wrong" from "the service is having a moment";
 * everything else keeps the status and a slice of the body for the notify.
 */
export function errorForStatus(status: number, body: string): Error {
  if (status === 401 || status === 403) return new JevAuthError(status);
  return new Error(`jev ${status}: ${body}`);
}

/**
 * Pinned, not `jev-latest`: the README's latency, cost and confidence figures were
 * measured against 1.13.0, and an alias that moves would make them quietly wrong.
 * Set TASK_ROUTER_JEV_MODEL=jev-latest to follow the alias on purpose.
 */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

export interface JevConfig {
  apiKey: string;
  baseUrl: string;
  /** A pinned id like "jev-1.13.0", or "jev-latest" to follow the alias. */
  model: string;
  /** Total budget for one classification, retries included. */
  timeoutMs: number;
  /** Characters of the prompt sent as `state`; the tail is dropped. */
  maxChars: number;
  /** Classifications kept in-process, keyed by (model, state). */
  cacheSize: number;
}

/** Only the fields we read. The API may return more; nothing else is trusted. */
interface JevChoiceAnswer {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface JevNoulAnswer {
  type?: string;
  noul?: number;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KIND_OPTIONS as string[]).includes(value);
}

function isComplexity(value: unknown): value is Complexity {
  return typeof value === "string" && (COMPLEXITY_OPTIONS as string[]).includes(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A choice's confidence is a probability in [0,1]. Missing counts as 0 (which the
 * floors in applyPolicy turn into ask_human); a present-but-garbage value is a
 * malformed response and throws, so the router degrades to the heuristic instead
 * of trusting an out-of-range number.
 */
function readChoiceConfidence(answer: JevChoiceAnswer, id: string): number {
  if (answer.confidence === undefined) return 0;
  if (!isProbability(answer.confidence)) {
    throw new Error(`unusable ${id} confidence: ${JSON.stringify(answer.confidence)}`);
  }
  return answer.confidence;
}

function readNoulAnswer(answers: Record<string, unknown>, id: string): number {
  const answer = answers[id] as JevNoulAnswer | undefined;
  if (!answer || answer.type !== "noul" || !isProbability(answer.noul)) {
    throw new Error(`unusable ${id} answer: ${JSON.stringify(answer)}`);
  }
  return answer.noul;
}

/** "bugfix 0.97, security 0.02" — the two most likely options, for tuning. */
function topProbabilities(probabilities: Record<string, number> | undefined): string {
  if (!probabilities) return "no probabilities";
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
    .join(", ");
}

/**
 * Pure: a Jev response in, a routing decision out. Exported so the mapping can be
 * exercised against canned responses without a network call or an API key.
 */
export function mapJevResponse(payload: JevResponse, latencyMs: number): ProviderOutcome {
  const answers = payload.answers ?? {};
  const kind = answers[TASK_KIND_QUESTION] as JevChoiceAnswer | undefined;
  const complexity = answers[COMPLEXITY_QUESTION] as JevChoiceAnswer | undefined;

  if (!kind || kind.type !== "choice" || !isTaskKind(kind.choice)) {
    throw new Error(`unusable ${TASK_KIND_QUESTION} answer: ${JSON.stringify(kind)}`);
  }
  if (!complexity || complexity.type !== "choice" || !isComplexity(complexity.choice)) {
    throw new Error(`unusable ${COMPLEXITY_QUESTION} answer: ${JSON.stringify(complexity)}`);
  }

  const repoMapAnswer = readNoulAnswer(answers, NEEDS_REPO_MAP_QUESTION);
  const humanAnswer = readNoulAnswer(answers, NEEDS_HUMAN_QUESTION);

  // Confidence is the task_kind choice's confidence, NOT the minimum of both
  // axes. See the file-header comment: complexity confidence is low by nature,
  // and using it as a veto would over-route to ask_human. Missing confidence
  // still counts as zero, which drives the floors in applyPolicy toward asking.
  const confidence = readChoiceConfidence(kind, TASK_KIND_QUESTION);

  const decision: Decision = {
    task_kind: kind.choice,
    complexity: complexity.choice,
    model_tier: BASE_TIER[kind.choice],
    needs_repo_map: repoMapAnswer >= NOUL_THRESHOLD,
    needs_human: humanAnswer >= NOUL_THRESHOLD,
    confidence,
    rationale: `jev: ${kind.choice} (${topProbabilities(kind.probabilities)})`,
  };

  const tokens = payload.usage?.input_tokens;
  // Complexity confidence is display-only: show it when valid, never throw on it.
  const complexityConfidence = complexity.confidence;
  const detail = [
    `jev ${payload.model ?? "unknown"}`,
    `${latencyMs}ms`,
    tokens === undefined ? undefined : `${tokens}in`,
    `kind ${kind.choice}(${confidence.toFixed(2)})`,
    `complexity ${complexity.choice}${isProbability(complexityConfidence) ? `(${complexityConfidence.toFixed(2)})` : ""}`,
    `repo_map ${decision.needs_repo_map ? "yes" : "no"}`,
    `human ${decision.needs_human ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return { decision, detail, modelVersion: payload.model };
}

/** A setTimeout that rejects when the signal aborts, so backoff never overruns the budget. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createJevProvider(config: JevConfig): ClassifierProvider {
  const cache = new Map<string, ProviderOutcome>();

  /**
   * One HTTP attempt sequence. The timeout controller is created once, outside
   * the retry loop, so timeoutMs is a budget for the whole call rather than per
   * attempt — a classification that eats the turn's latency budget is worse than
   * a classification that falls back to heuristics.
   */
  async function request(state: string): Promise<JevResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);

    try {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch(`${config.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, model: config.model, questions: JEV_QUESTIONS }),
          signal: controller.signal,
        });

        if (response.ok) {
          return (await response.json()) as JevResponse;
        }

        const body = (await response.text()).slice(0, 300);
        lastError = errorForStatus(response.status, body);

        // The docs name 429 and 529 as the two retryable statuses, and say to
        // honour retry-after when it is present. Auth statuses are already
        // non-retryable here, so they surface on the first attempt.
        const retryable = response.status === 429 || response.status === 529;
        if (!retryable || attempt === 2) throw lastError;

        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 1000)
            : 250 * 2 ** attempt;
        await sleep(waitMs, controller.signal);
      }

      throw lastError ?? new Error("jev: retries exhausted");
    } catch (error) {
      if (timedOut) throw new Error(`jev timed out after ${config.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "jev",

    async classify(prompt: string): Promise<ProviderOutcome> {
      const state = prompt.slice(0, config.maxChars);

      const key = `${config.model}\u0000${state}`;
      const cached = cache.get(key);
      if (cached) return { ...cached, detail: `${cached.detail} · cached` };

      const startedAt = Date.now();
      const payload = await request(state);
      const outcome = mapJevResponse(payload, Date.now() - startedAt);

      cache.set(key, outcome);
      if (cache.size > config.cacheSize) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }

      return outcome;
    },
  };
}
