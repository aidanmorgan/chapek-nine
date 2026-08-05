import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openEvaluationCheckpoint } from "../scripts/infrastructure/persistence/evaluation-checkpoint-store.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-eval-checkpoint-"));
const outputPath = path.join(directory, "routing-evals.json");
const identity = { suiteVersion: 1, mode: "full", artifacts: { worker: { quant: "Q4" } } };
const first = openEvaluationCheckpoint({ outputPath, identity });
first.append({ model: "worker", taskId: "task", maxTokens: 160, score: 1 });
assert.equal(first.has("worker", "task", 160), true);
const resumed = openEvaluationCheckpoint({ outputPath, identity });
assert.equal(resumed.rows.length, 1);
assert.throws(
  () => openEvaluationCheckpoint({ outputPath, identity: { ...identity, mode: "quick" } }),
  /incompatible/,
);
resumed.complete();
assert.equal(fs.existsSync(`${outputPath}.checkpoint.jsonl`), false);
fs.rmSync(directory, { recursive: true, force: true });
console.log("evaluation checkpoint: ok");
