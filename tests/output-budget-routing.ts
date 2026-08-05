import assert from "node:assert/strict";
import { chooseRoute } from "../scripts/domain/routing-policy.ts";

const config = {
  roles: { general: ["fast"], implementer: ["coder"] },
  coordinator: ["fast"],
  synthesizer: ["fast"],
  maxAssignments: 2,
  tokens: { byTier: { simple: 320, moderate: 800, high: 1400 } },
  budgetPlans: { implementer: { moderate: { model: "coder", maxTokens: 900 } } },
};
const high = chooseRoute(
  {
    messages: [
      {
        role: "user",
        content: "Implement a complex end-to-end production migration across all files.",
      },
    ],
  },
  config,
  new Set(["fast", "coder"]),
);
assert.equal(high.model, "coder");
assert.equal(high.maxTokens, 900);
const simple = chooseRoute(
  { messages: [{ role: "user", content: "ping" }] },
  config,
  new Set(["fast", "coder"]),
);
assert.equal(simple.maxTokens, 320);
console.log("output budget routing tests passed");
