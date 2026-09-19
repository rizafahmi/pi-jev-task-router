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
import { isMoreExpensive, MODEL_PRICE_RANK, TIER_MODELS } from "./policy.ts";

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
