import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfidentLookup, isConfidentRoute } from "../src/routing.js";

// Numbers taken from real decisions this bar is meant to let through or keep out.
test("a read-only lookup clears a lower bar than an action with side effects", () => {
  const observed = { choice: "list_agents", confidence: 0.48,
    probabilities: { list_agents: 0.51, continue: 0.31, clarify: 0.18 } };
  assert.equal(isConfidentRoute(observed), false, "it could never clear the side-effect bar");
  assert.equal(isConfidentLookup(observed), true);
});

test("a coin flip between two lookups still asks", () => {
  assert.equal(isConfidentLookup({ choice: "list_agents", confidence: 0.5,
    probabilities: { list_agents: 0.44, list_sessions: 0.40, clarify: 0.16 } }), false);
});

test("a lookup that is not the front runner never auto-runs", () => {
  assert.equal(isConfidentLookup({ choice: "list_agents", confidence: 0.9,
    probabilities: { list_agents: 0.30, continue: 0.60, clarify: 0.10 } }), false);
});

test("the side-effect bar is untouched", () => {
  assert.equal(isConfidentRoute({ choice: "continue", confidence: 0.98,
    probabilities: { continue: 0.99, clarify: 0.01 } }), true);
  assert.equal(isConfidentRoute({ choice: "continue", confidence: 0.76,
    probabilities: { continue: 0.92, clarify: 0.08 } }), false, "0.76 confidence still falls short");
});
