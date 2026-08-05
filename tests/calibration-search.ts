import assert from "node:assert/strict";
import { adaptiveSearch, initialCandidate } from "../scripts/calibration-search.ts";

const profile = { hybridMoe: true, cpuMoeLayers: 6 };
const seed = initialCandidate({ profile, totalRamGiB: 32, totalVramMiB: 16384, logicalCpus: 16 });
assert.equal(seed.cpuMoeLayers, 6);
assert.ok(seed.batchSize >= 64 && seed.batchSize <= 1024);
assert.ok(seed.ubatchSize <= seed.batchSize);
assert.equal(seed.threads, 8);
assert.equal(seed.flashAttention, true);
assert.equal(seed.context, 4096);

const seen = [];
const results = await adaptiveSearch({
  profile,
  totalRamGiB: 32,
  totalVramMiB: 16384,
  logicalCpus: 16,
  mode: "quick",
  evaluate: async (candidate) => {
    seen.push(candidate);
    // Peak at a setting which is not the seed: verifies that measurements,
    // rather than a fixed candidate list, direct the search.
    const score =
      100 -
      Math.abs(candidate.cpuMoeLayers - 4) * 10 -
      Math.abs(candidate.batchSize - 256) / 16 -
      Math.abs(candidate.ubatchSize - 128) / 8;
    return { ...candidate, ok: true, score };
  },
});
assert.ok(results.length <= 16);
assert.equal(new Set(seen.map((candidate) => JSON.stringify(candidate))).size, seen.length);
assert.ok(results.some((result) => result.cpuMoeLayers === 4));
assert.ok(results.every((result) => Number.isInteger(result.threads)));
assert.ok(results.every((result) => typeof result.flashAttention === "boolean"));
assert.ok(results.every((result) => result.cacheTypeK && result.cacheTypeV));
assert.equal([...results].sort((a, b) => b.score - a.score)[0].cpuMoeLayers, 4);
console.log("calibration adaptive-search tests passed");
