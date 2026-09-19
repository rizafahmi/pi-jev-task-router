/**
 * task-router — canned-response tests for the Jev mapping.
 *
 * mapJevResponse is exported precisely so the wire contract can be checked
 * without a network call or an API key; this is the file that uses it. The
 * well-formed case is a live jev-1.13.0 response, the rest are the malformed
 * shapes the mapper has to reject rather than guess at.
 *
 *   node --test  (node 24 runs .ts directly, no deps, no config)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorForStatus, isJevAuthError, JevAuthError, mapJevResponse, normalizeApiKey } from "./jev.ts";
import { NOUL_THRESHOLD } from "../policy.ts";

/** One live-shaped response; `answers` entries are overridden per test. */
function response(answers: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 915, output_tokens: 12 },
    answers: {
      task_kind: {
        type: "choice",
        choice: "bugfix",
        confidence: 0.96,
        probabilities: { bugfix: 0.97, security: 0.03 },
      },
      complexity: {
        type: "choice",
        choice: "S",
        confidence: 0.31,
        probabilities: { S: 0.45, M: 0.55 },
      },
      needs_repo_map: { type: "noul", noul: 0.68 },
      needs_human: { type: "noul", noul: 0.06 },
      ...answers,
    },
  };
}

test("a well-formed response yields the decision, the kind's confidence and the detail", () => {
  const { decision, detail } = mapJevResponse(response(), 1400);

  assert.equal(decision.task_kind, "bugfix");
  assert.equal(decision.complexity, "S");
  assert.equal(decision.model_tier, "fast_cheap");
  assert.equal(decision.needs_repo_map, true);
  assert.equal(decision.needs_human, false);
  // The kind's confidence, not the complexity's 0.31: see the file header.
  assert.equal(decision.confidence, 0.96);
  assert.match(detail, /^jev jev-1\.13\.0 · 1400ms · 915in/);
  assert.match(detail, /repo_map yes · human no/);
});

test("a noul exactly at the threshold counts as true", () => {
  const { decision } = mapJevResponse(
    response({ needs_human: { type: "noul", noul: NOUL_THRESHOLD } }),
    1,
  );

  assert.equal(decision.needs_human, true);
});

test("a noul without a type field is rejected", () => {
  assert.throws(
    () => mapJevResponse(response({ needs_human: { noul: 0.1 } }), 1),
    /unusable needs_human answer/,
  );
});

test("a missing noul answer is rejected", () => {
  const payload = response();
  delete (payload.answers as Record<string, unknown>).needs_repo_map;

  assert.throws(() => mapJevResponse(payload, 1), /unusable needs_repo_map answer/);
});

test("a noul outside [0, 1] is rejected", () => {
  for (const noul of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
    assert.throws(
      () => mapJevResponse(response({ needs_human: { type: "noul", noul } }), 1),
      /unusable needs_human answer/,
      `expected ${String(noul)} to be rejected`,
    );
  }
});

test("an option name that is not in the question is rejected", () => {
  assert.throws(
    () => mapJevResponse(response({ task_kind: { type: "choice", choice: "bug_fix" } }), 1),
    /unusable task_kind answer/,
  );
});

test("a missing task_kind confidence becomes 0 rather than throwing", () => {
  const payload = response({ task_kind: { type: "choice", choice: "bugfix" } });

  // applyPolicy() turns confidence 0 into ask_human; the mapper must not guess.
  assert.equal(mapJevResponse(payload, 1).decision.confidence, 0);
});

test("a task_kind confidence outside [0, 1] is rejected", () => {
  for (const confidence of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.9"]) {
    assert.throws(
      () => mapJevResponse(response({ task_kind: { type: "choice", choice: "bugfix", confidence } }), 1),
      /unusable task_kind confidence/,
      `expected confidence ${String(confidence)} to be rejected`,
    );
  }
});

test("a complexity confidence outside [0, 1] is dropped from the detail, not thrown", () => {
  const { decision, detail } = mapJevResponse(
    response({ complexity: { type: "choice", choice: "M", confidence: 42 } }),
    1,
  );

  // Complexity confidence is display-only; garbage there must not discard a good kind.
  assert.equal(decision.complexity, "M");
  assert.doesNotMatch(detail, /42/);
});

/**
 * TYPESAFE_API_KEY presence. The router decides between Jev and the heuristic by
 * whether a key *exists*, so "exists" has to mean a usable string: a blank value
 * used to be read as present, which reported the classifier as "jev" while every
 * call 403'd and degraded to the heuristic anyway.
 */

test("an absent key is absent", () => {
  assert.equal(normalizeApiKey(undefined), undefined);
});

test("a blank key counts as absent, never as present", () => {
  assert.equal(normalizeApiKey(""), undefined);
  assert.equal(normalizeApiKey(" "), undefined);
  assert.equal(normalizeApiKey("\t\n  "), undefined);
});

test("a real key is trimmed and kept", () => {
  assert.equal(normalizeApiKey("sk-live-abc123"), "sk-live-abc123");
  assert.equal(normalizeApiKey("  sk-live-abc123  "), "sk-live-abc123");
  assert.equal(normalizeApiKey("\nsk-live-abc123\t"), "sk-live-abc123");
});

/**
 * Auth failure vs transient failure. The router treats a rejected key as a setup
 * error (it turns itself off), while a 5xx is retried and degraded per turn — so
 * the classification has to be exact, and it lives in one pure function.
 */

test("401 and 403 are auth errors", () => {
  for (const status of [401, 403]) {
    const error = errorForStatus(status, "irrelevant");
    assert.ok(isJevAuthError(error), `${status} should be an auth error`);
    assert.equal((error as JevAuthError).status, status);
    assert.match(error.message, /rejected the API key/);
    assert.match(error.message, new RegExp(`HTTP ${status}`));
  }
});

test("a retryable status is not an auth error", () => {
  // 429 is the retry path; it must never disable the router.
  assert.equal(isJevAuthError(errorForStatus(429, "slow down")), false);
});

test("other failures keep the status and body, and are not auth errors", () => {
  const error = errorForStatus(500, "upstream exploded");
  assert.equal(isJevAuthError(error), false);
  assert.equal(error.name, "Error");
  assert.match(error.message, /jev 500/);
  assert.match(error.message, /upstream exploded/);
});

test("isJevAuthError rejects anything that is not one", () => {
  assert.equal(isJevAuthError(new Error("nope")), false);
  assert.equal(isJevAuthError(undefined), false);
  assert.equal(isJevAuthError("403"), false);
  // Not a duck type: an Error that merely mentions 403 must not disable routing.
  assert.equal(isJevAuthError(new Error("jev 403: bad key")), false);
});
