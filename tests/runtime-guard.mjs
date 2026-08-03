import assert from "node:assert/strict";
import { resourceDecision } from "../scripts/runtime-guard.mjs";
assert.equal(resourceDecision({ freeRamGiB: 1, gpu: null }).admit, false);
assert.equal(resourceDecision({ freeRamGiB: 4, gpu: { freeMiB: 2048, temperatureC: 60 } }).admit, true);
assert.equal(resourceDecision({ freeRamGiB: 4, gpu: { freeMiB: 100, temperatureC: 60 } }).admit, false);
console.log("runtime guard tests passed");
