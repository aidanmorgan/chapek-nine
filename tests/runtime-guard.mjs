import assert from "node:assert/strict";
import { resourceDecision } from "../scripts/runtime-guard.mjs";
assert.equal(resourceDecision({ totalRamGiB: 32, freeRamGiB: 1, gpu: null }).admit, false);
assert.equal(resourceDecision({ totalRamGiB: 32, freeRamGiB: 4, gpu: { totalMiB: 16_000, freeMiB: 2048, temperatureC: 60 } }).admit, true);
assert.equal(resourceDecision({ totalRamGiB: 32, freeRamGiB: 4, gpu: { totalMiB: 16_000, freeMiB: 100, temperatureC: 60 } }).admit, false);
console.log("runtime guard tests passed");
