/**
 * task-router — the seam between the router and whatever does the classifying.
 *
 * The router never talks to Jev directly; it talks to a ClassifierProvider. The
 * heuristic provider (providers/fake.ts) and the real one (providers/jev.ts)
 * are interchangeable behind this interface, which is what keeps the router's
 * model policy testable without a network.
 */

import type { Decision } from "../schema.ts";

export interface ProviderOutcome {
  /** The routing contract. Nothing outside policy.ts may widen this. */
  decision: Decision;
  /**
   * Provenance for `notify` and `/router`: model version, latency, token count,
   * top probabilities. Never parsed, only displayed.
   */
  detail: string;
  /** Versioned model id reported by the API, when the provider reports one. */
  modelVersion?: string;
}

export interface ClassifierProvider {
  /** Short label used in notifies: "jev" or "fake". */
  name: string;
  classify(prompt: string, signal?: AbortSignal): Promise<ProviderOutcome>;
}
