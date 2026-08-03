import assert from "node:assert/strict";
import { assignUtilities, calibratedHeadroom } from "../scripts/routing-objective.mjs";

const objective = {
  tiers: { simple: { quality: 0.4, decodeTps: 0.3, latency: 0.2, memoryHeadroom: 0.1 } },
  minimumMemoryHeadroom: 0.15,
};
const rows = assignUtilities([
  { taskId: "a", tier: "simple", model: "quality", score: 1, generationTps: 20, latencyMs: 300, memoryHeadroom: 1 },
  { taskId: "a", tier: "simple", model: "fast", score: 0.8, generationTps: 100, latencyMs: 40, memoryHeadroom: 1 },
  { taskId: "a", tier: "simple", model: "unsafe", score: 1, generationTps: 200, latencyMs: 20, memoryHeadroom: 0.1 },
], objective);
assert.ok(rows.find((row) => row.model === "fast").utility > rows.find((row) => row.model === "quality").utility);
assert.equal(rows.find((row) => row.model === "unsafe").utility, 0);
assert.equal(calibratedHeadroom({ benchmark: { minFreeRamGiB: 2, minFreeVramMiB: 1024 } }), 1);
console.log("routing objective tests passed");
