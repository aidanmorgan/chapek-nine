import assert from "node:assert/strict";
import { chooseRoute } from "../scripts/domain/routing-policy.ts";

const config = {
  coordinator: ["public"],
  synthesizer: ["public"],
  roles: {
    implementer: ["specialist", "public"],
    analyst: ["specialist"],
    reviewer: ["specialist"],
  },
  maxAssignments: 2,
  tokens: { synthesizer: 800, byTier: { high: 1400 } },
};
const route = chooseRoute(
  {
    messages: [
      {
        role: "user",
        content:
          "Implement TypeScript code across all repository files for a complex production architecture migration with multiple validation steps.",
      },
    ],
  },
  config,
  { publicWorkers: new Set(["public"]), specialistWorkers: new Set(["public", "specialist"]) },
);
assert.equal(route.model, "public");
assert.ok(route.assignments.some((assignment) => assignment.model === "specialist"));
console.log("admission routing: ok");
