/**
 * task-router — tests for the confirm gate's price ordering.
 *
 * isMoreExpensive decides whether the TUI asks before a model switch. The one
 * property that must not regress: an unknown model is never treated as cheap,
 * because a widened TIER_MODELS without a matching MODEL_PRICE_RANK entry would
 * otherwise silently skip confirmation.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isMoreExpensive,
  MODEL_PRICE_RANK,
  parseTierModels,
  resolveTierModel,
  TIER_MODELS,
} from "./policy.ts";

const FLASH = { provider: "deepseek", id: "deepseek-v4-flash" };
const PRO = { provider: "deepseek", id: "deepseek-v4-pro" };
const UNKNOWN = { provider: "openai", id: "gpt-99" };

test("a known upgrade asks for confirmation", () => {
  assert.equal(isMoreExpensive(FLASH, PRO), true);
});

test("a known downgrade does not ask", () => {
  assert.equal(isMoreExpensive(PRO, FLASH), false);
});

test("a no-op switch never asks", () => {
  assert.equal(isMoreExpensive(FLASH, FLASH), false);
  assert.equal(isMoreExpensive(PRO, PRO), false);
});

test("an unknown current model is treated as cheapest", () => {
  // Switching away from an unknown model to the cheap one must not ask.
  assert.equal(isMoreExpensive(UNKNOWN, FLASH), false);
});

test("an unknown target model always asks (fails closed)", () => {
  assert.equal(isMoreExpensive(FLASH, UNKNOWN), true);
  assert.equal(isMoreExpensive(PRO, UNKNOWN), true);
  assert.equal(isMoreExpensive(undefined, UNKNOWN), true);
});

test("every allowlisted model has a price rank", () => {
  // Guards the invariant behind the fail-closed gate: TIER_MODELS and
  // MODEL_PRICE_RANK must not drift apart.
  for (const tier of Object.values(TIER_MODELS)) {
    for (const ref of tier) {
      const key = `${ref.provider}/${ref.modelId}`;
      assert.ok(key in MODEL_PRICE_RANK, `${key} is missing from MODEL_PRICE_RANK`);
    }
  }
});

/**
 * TASK_ROUTER_TIERS is the one knob a new user must touch: the shipped model ids
 * are one machine's catalogue. It is validated once at load time and reported as
 * a single actionable error, because a silently-unresolvable table turns into a
 * failed route on every prompt.
 */

function tiers(raw: string | undefined) {
  const parsed = parseTierModels(raw);
  assert.ok(!("error" in parsed), `expected a parsed table, got: ${JSON.stringify(parsed)}`);
  return parsed.tiers;
}

function error(raw: string | undefined) {
  const parsed = parseTierModels(raw);
  assert.ok("error" in parsed, `expected an error, got: ${JSON.stringify(parsed)}`);
  return parsed.error;
}

test("an unset or blank override keeps the shipped defaults", () => {
  assert.deepEqual(tiers(undefined), TIER_MODELS);
  assert.deepEqual(tiers(""), TIER_MODELS);
  assert.deepEqual(tiers("   "), TIER_MODELS);
});

test("an omitted tier keeps its default", () => {
  // Partial overrides are the common case: fix the tier your catalogue lacks.
  const parsed = tiers(JSON.stringify({ fast_cheap: ["anthropic/claude-haiku-4-5"] }));
  assert.deepEqual(parsed.fast_cheap, [{ provider: "anthropic", modelId: "claude-haiku-4-5" }]);
  assert.deepEqual(parsed.balanced, TIER_MODELS.balanced);
  assert.deepEqual(parsed.frontier, TIER_MODELS.frontier);
});

test("parsing an override never mutates the shipped defaults", () => {
  tiers(JSON.stringify({ fast_cheap: ["anthropic/claude-haiku-4-5"] }));
  assert.deepEqual(TIER_MODELS.fast_cheap, [{ provider: "deepseek", modelId: "deepseek-v4-flash" }]);
});

test("a model id may contain slashes of its own", () => {
  // Split on the first slash only: provider is the namespace, not the vendor.
  const parsed = tiers(JSON.stringify({ balanced: ["openrouter/meta-llama/llama-3-70b"] }));
  assert.deepEqual(parsed.balanced, [{ provider: "openrouter", modelId: "meta-llama/llama-3-70b" }]);
});

test("malformed overrides are rejected with one readable error", () => {
  assert.match(error("not json"), /not valid JSON/);
  assert.match(error("[\"deepseek/deepseek-v4-flash\"]"), /must be a JSON object/);
  assert.match(error("\"deepseek/deepseek-v4-flash\""), /must be a JSON object/);
  assert.match(error("null"), /must be a JSON object/);
});

test("an unknown tier, a non-array and an empty array are rejected", () => {
  assert.match(error(JSON.stringify({ cheap: ["a/b"] })), /unknown tier "cheap"/);
  assert.match(error(JSON.stringify({ fast_cheap: "a/b" })), /must be an array/);
  assert.match(error(JSON.stringify({ fast_cheap: [] })), /is empty/);
});

test("an entry that is not a provider/modelId pair is rejected", () => {
  assert.match(error(JSON.stringify({ fast_cheap: [42] })), /must be a "provider\/modelId" string/);
  assert.match(error(JSON.stringify({ fast_cheap: ["deepseek-v4-flash"] })), /must look like/);
  assert.match(error(JSON.stringify({ fast_cheap: ["/deepseek-v4-flash"] })), /must look like/);
  assert.match(error(JSON.stringify({ fast_cheap: ["deepseek/"] })), /must look like/);
  assert.match(error(JSON.stringify({ fast_cheap: ["deepseek /flash"] })), /must look like/);
});

test("resolution uses the supplied table, not the shipped one", () => {
  const known = new Set(["deepseek/deepseek-v4-flash", "local/small"]);
  const registry = {
    find: (provider: string, modelId: string) =>
      known.has(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined,
    hasConfiguredAuth: () => true,
  };
  const parsed = tiers(JSON.stringify({ fast_cheap: ["local/small"] }));
  assert.equal(resolveTierModel(registry, "fast_cheap")?.id, "deepseek-v4-flash");
  assert.equal(resolveTierModel(registry, "fast_cheap", parsed)?.id, "small");
});
