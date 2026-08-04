import assert from "node:assert/strict";
import { createRuntimeState } from "../scripts/runtime-state.mjs";

const state = createRuntimeState(null);
state.begin("model-a");
state.allocation("model-a", { freeRamGiB: 20, gpu: { usedMiB: 100 } }, { freeRamGiB: 14.5, gpu: { usedMiB: 2100 } });
state.resource("model-a", 9 * 2 ** 30, 2200 * 1048576);
state.complete("model-a", { latencyMs: 100, promptTps: 200, decodeTps: 50 });
const model = state.snapshot().models["model-a"];
assert.equal(model.requests, 1);
assert.equal(model.allocatedRamBytes, Math.round(5.5 * 2 ** 30));
assert.equal(model.allocatedVramBytes, 2000 * 1048576);
assert.equal(model.observedVramBytes, 2200 * 1048576);
assert.equal(model.averageLatencyMs, 100);
assert.equal(model.decodeTps, 50);
assert.equal(state.active(), "model-a");
console.log("runtime state: ok");
