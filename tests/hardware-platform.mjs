import assert from "node:assert/strict";
import { probeHardware, sampleAcceleratorMemory } from "../scripts/platform/hardware.mjs";

const hardware = probeHardware();
assert.equal(hardware.platform, process.platform);
assert.ok(Number.isFinite(hardware.totalRamBytes) && hardware.totalRamBytes > 0);
assert.ok(Number.isInteger(hardware.logicalCpus) && hardware.logicalCpus > 0);
if (process.platform === "darwin") {
  assert.equal(hardware.gpu?.kind, "unified");
  assert.equal(hardware.gpu?.backend, "metal");
  assert.equal(sampleAcceleratorMemory(), null);
}
console.log("hardware platform tests passed");
