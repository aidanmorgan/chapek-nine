import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeveloperTaskSuite } from "../scripts/developer-task-suite.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = loadDeveloperTaskSuite(root);
const counts = new Map();
for (const task of suite.tasks) {
  counts.set(task.role, (counts.get(task.role) || 0) + 1);
  assert.ok(task.prompt.length >= 80, `${task.id} should be a substantive task`);
  assert.ok(task.requiredAll.length > 0, `${task.id} needs deterministic scoring`);
}
assert.equal(suite.coreTaskCount, 24);
assert.equal(suite.generatedTaskCount, 720);
assert.equal(suite.tasks.length, 744);
assert.equal(suite.sampling.holdoutFamiliesPerRole, 97);
for (const role of ["implementer", "analyst", "reviewer"]) {
  assert.ok(counts.get(role) >= 240, `${role} needs broad coverage`);
}
console.log("developer task suite tests passed");
