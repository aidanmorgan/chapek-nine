import assert from "node:assert/strict";
import { resourceDecision, waitForAdmission } from "../scripts/runtime-guard.ts";
assert.equal(resourceDecision({ totalRamGiB: 32, freeRamGiB: 1, gpu: null }).admit, false);
assert.equal(
  resourceDecision({
    totalRamGiB: 32,
    freeRamGiB: 4,
    gpu: { totalMiB: 16_000, freeMiB: 2048, temperatureC: 60 },
  }).admit,
  true,
);
assert.equal(
  resourceDecision({
    totalRamGiB: 32,
    freeRamGiB: 4,
    gpu: { totalMiB: 16_000, freeMiB: 100, temperatureC: 60 },
  }).admit,
  false,
);
let calls = 0;
const cooled = await waitForAdmission({
  sample: () => ({
    totalRamGiB: 32,
    freeRamGiB: 4,
    gpu: { totalMiB: 16_000, freeMiB: 2048, temperatureC: calls++ ? 60 : 90 },
  }),
  limits: { maxTemperatureC: 86 },
  intervalMs: 0,
  sleep: async () => {},
});
assert.equal(cooled.admit, true);
console.log("runtime guard tests passed");
