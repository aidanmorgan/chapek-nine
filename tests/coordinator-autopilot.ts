import assert from "node:assert/strict";
import { decision } from "../scripts/coordinator-autopilot.ts";
const inputs = { inputHash: "new" };
assert.equal(decision({ adapterExists: false, inputs }).action, "improve");
assert.equal(
  decision({ adapterExists: true, inputs, previous: { inputHash: "old", accepted: true } }).action,
  "improve",
);
assert.equal(
  decision({ adapterExists: true, inputs, previous: { inputHash: "new", accepted: false } }).action,
  "improve",
);
assert.equal(
  decision({ adapterExists: true, inputs, previous: { inputHash: "new", accepted: true } }).action,
  "hold",
);
console.log("coordinator autopilot: ok");
