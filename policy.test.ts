/**
 * task-router — tests for the confirm gate's cost ordering.
 *
 * isMoreExpensive decides whether the TUI asks before a model switch. Cost order is
 * derived from the tier table, so the property that must not regress is the
 * fail-closed one: a target in no tier is never treated as cheap, because a widened
 * rotation would otherwise silently skip confirmation.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isMoreExpensive,
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

test("an override ranks by tier, with no second table to keep in sync", () => {
  // The case that motivated deriving the order: point the rotation at a catalogue the
  // shipped defaults know nothing about.
  const custom = tiers(
    JSON.stringify({
      fast_cheap: ["anthropic/claude-haiku-4-5"],
      balanced: ["anthropic/claude-sonnet-4-5"],
      frontier: ["anthropic/claude-opus-4-1"],
    }),
  );
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const opus = { provider: "anthropic", id: "claude-opus-4-1" };

  assert.equal(isMoreExpensive(haiku, sonnet, custom), true);
  assert.equal(isMoreExpensive(sonnet, haiku, custom), false);
  assert.equal(isMoreExpensive(sonnet, opus, custom), true);
  assert.equal(isMoreExpensive(undefined, haiku, custom), false);
  // Still fails closed for a model this table does not list.
  assert.equal(isMoreExpensive(haiku, UNKNOWN, custom), true);
});

test("the same model behind a different gateway ranks the same", () => {
  // sumopod/deepseek-v4-flash is the same model as deepseek/deepseek-v4-flash. The
  // gateway is not part of the model's identity, so a reseller must not change the
  // gate's answer — which it did when the order came from a provider-keyed table.
  const viaGateway = tiers(
    JSON.stringify({
      fast_cheap: ["sumopod/deepseek-v4-flash"],
      balanced: ["sumopod/deepseek-v4-pro"],
      frontier: ["sumopod/deepseek-v4-pro"],
    }),
  );
  const gatewayFlash = { provider: "sumopod", id: "deepseek-v4-flash" };
  const gatewayPro = { provider: "sumopod", id: "deepseek-v4-pro" };

  assert.equal(isMoreExpensive(gatewayFlash, gatewayPro, viaGateway), true);
  assert.equal(isMoreExpensive(gatewayPro, gatewayFlash, viaGateway), false);
});

test("two models in the same tier are not a price step", () => {
  // The tier table is the cost knob: peers inside one tier never prompt.
  const twoInBalanced = tiers(
    JSON.stringify({ balanced: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"] }),
  );
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const gpt = { provider: "openai", id: "gpt-5" };

  assert.equal(isMoreExpensive(sonnet, gpt, twoInBalanced), false);
  assert.equal(isMoreExpensive(gpt, sonnet, twoInBalanced), false);
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
