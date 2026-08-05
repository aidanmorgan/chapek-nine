import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoordinatorDecisionPolicy } from "../scripts/domain/coordinator-decision.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "config", "coordinator-schema.json"), "utf8"),
);
const policy = createCoordinatorDecisionPolicy({
  schema,
  orchestration: {
    coordinator: ["qwen-coder"],
    synthesizer: [],
    roles: {
      analyst: ["glm-flash"],
      implementer: ["qwen-coder"],
      reviewer: ["granite"],
    },
    maxAssignments: 2,
  },
  coordinator: { minimumConfidence: 0.7 },
});
const availability = {
  publicWorkers: new Set(["qwen-coder"]),
  specialistWorkers: new Set(["glm-flash", "granite"]),
};
const fallback = {
  maxTokens: 128,
  classification: { tier: "moderate", primaryRole: "implementer" },
};
const valid = {
  version: 1,
  tier: "high",
  primary: { role: "implementer", model: "qwen-coder", maxTokens: 256 },
  steps: [
    {
      role: "analyst",
      model: "glm-flash",
      instruction: "Inspect the task and identify important constraints.",
      access: [],
    },
  ],
  confidence: 0.9,
};

assert.deepEqual(policy.resolve(valid, availability, fallback), {
  model: "qwen-coder",
  maxTokens: 256,
  assignments: [
    {
      role: "analyst",
      model: "glm-flash",
      instruction: "Inspect the task and identify important constraints.",
      access: [],
    },
  ],
  classification: { tier: "high", primaryRole: "implementer" },
  confidence: 0.9,
  policy: "lora",
});
assert.equal(policy.resolve({ ...valid, unexpected: true }, availability, fallback), null);
assert.equal(
  policy.resolve(
    { ...valid, primary: { ...valid.primary, model: "unadmitted-worker" } },
    availability,
    fallback,
  ),
  null,
);
assert.equal(policy.resolve({ ...valid, confidence: 0.69 }, availability, fallback), null);
console.log("coordinator decision policy tests passed");
