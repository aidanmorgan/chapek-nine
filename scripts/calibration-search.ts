// Bounded, measurement-driven coordinate ascent for calibration.  The
// objective is supplied by calibrate.ts, so this module remains deterministic
// when a benchmark produces deterministic measurements.

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function powerOfTwoAtMost(value) {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

function key(candidate) {
  return [
    candidate.offloadMode,
    candidate.cpuMoeLayers ?? "",
    candidate.fitTargetMiB ?? "",
    candidate.batchSize,
    candidate.ubatchSize,
    candidate.threads,
    candidate.cacheTypeK,
    candidate.cacheTypeV,
    candidate.flashAttention ? "fa" : "no-fa",
    candidate.context,
  ].join(":");
}

function sameCandidate(left, right) {
  return key(left) === key(right);
}

export function initialCandidate({ profile, totalRamGiB, totalVramMiB, logicalCpus }) {
  // Start from observed hardware capacity, not a hand-written batch grid. The
  // conservative cap prevents the very first benchmark from destabilising a
  // desktop with a large RAM-only model.
  const capacityMiB = totalRamGiB * 1024 + totalVramMiB;
  const batchSize = clamp(powerOfTwoAtMost(capacityMiB / 96), 64, 1024);
  const ubatchSize = clamp(powerOfTwoAtMost(batchSize / 2), 32, batchSize);
  const threads = clamp(
    powerOfTwoAtMost(Math.max(1, logicalCpus / 2)),
    1,
    Math.max(1, logicalCpus),
  );
  const common = {
    batchSize,
    ubatchSize,
    threads,
    cacheTypeK: profile.cacheTypeK || "q8_0",
    cacheTypeV: profile.cacheTypeV || "q8_0",
    flashAttention: true,
    context: Number(profile.context || 4096),
  };
  if (profile.hybridMoe) {
    return {
      ...common,
      offloadMode: "partial-cpu-moe",
      cpuMoeLayers: Math.max(0, Number(profile.cpuMoeLayers ?? 0)),
    };
  }
  return {
    ...common,
    offloadMode: "auto",
    // fit target is derived from currently usable VRAM. Leave a 12.5% desktop
    // reserve, never asking llama.cpp to reserve more than 2 GiB initially.
    fitTargetMiB: clamp(Math.floor(totalVramMiB * 0.875), 512, 2048),
  };
}

export async function adaptiveSearch({
  profile,
  totalRamGiB,
  totalVramMiB,
  logicalCpus,
  mode,
  evaluate,
}) {
  // Hardware settings have categorical choices as well as numeric placement
  // values. Keep the search bounded so a large GGUF never turns calibration
  // into an unbounded all-day experiment.
  const budget = mode === "full" ? 36 : 16;
  const visited = new Set();
  const results = [];
  const maxCpuMoeLayers = Math.max(1, Math.ceil(Number(profile.cpuMoeLayers ?? 0) * 2));
  let current = initialCandidate({ profile, totalRamGiB, totalVramMiB, logicalCpus });
  let steps = {
    // Use the configured placement only as the safe starting point; a third
    // of that placement is a useful initial finite-difference distance.
    cpuMoeLayers: Math.max(1, Math.ceil(current.cpuMoeLayers / 3)),
    batchSize: Math.max(32, current.batchSize / 2),
    ubatchSize: Math.max(16, current.ubatchSize / 2),
    fitTargetMiB: Math.max(128, powerOfTwoAtMost(current.fitTargetMiB / 4 || 128)),
    threads: Math.max(1, powerOfTwoAtMost(current.threads / 2)),
  };

  async function measure(candidate) {
    const id = key(candidate);
    if (visited.has(id) || results.length >= budget) return null;
    visited.add(id);
    const result = await evaluate(candidate, results.length, budget);
    results.push(result);
    return result;
  }

  let currentResult = await measure(current);
  while (currentResult && results.length < budget) {
    const neighbours = [];
    const add = (candidate) => {
      if (!sameCandidate(candidate, current) && !visited.has(key(candidate)))
        neighbours.push(candidate);
    };
    const batchUp = clamp(current.batchSize + steps.batchSize, 32, 2048);
    const batchDown = clamp(current.batchSize - steps.batchSize, 32, 2048);
    for (const batchSize of [batchDown, batchUp]) {
      add({ ...current, batchSize, ubatchSize: Math.min(current.ubatchSize, batchSize) });
    }
    const ubatchUp = clamp(current.ubatchSize + steps.ubatchSize, 16, current.batchSize);
    const ubatchDown = clamp(current.ubatchSize - steps.ubatchSize, 16, current.batchSize);
    for (const ubatchSize of [ubatchDown, ubatchUp]) add({ ...current, ubatchSize });
    const threadsUp = clamp(current.threads + steps.threads, 1, logicalCpus);
    const threadsDown = clamp(current.threads - steps.threads, 1, logicalCpus);
    for (const threads of [threadsDown, threadsUp]) add({ ...current, threads });

    // KV quantization and Flash Attention are meaningful only when measured
    // against this model, context, and GPU. Explore one conservative paired
    // cache alternative at a time; invalid backend combinations are rejected
    // by runCandidate and never selected.
    const cacheModes = [
      ...new Set([
        `${current.cacheTypeK}:${current.cacheTypeV}`,
        "q8_0:q8_0",
        "q4_0:q4_0",
        "f16:f16",
      ]),
    ];
    for (const cacheMode of cacheModes) {
      const [cacheTypeK, cacheTypeV] = cacheMode.split(":");
      add({ ...current, cacheTypeK, cacheTypeV });
    }
    add({ ...current, flashAttention: !current.flashAttention });
    if (mode === "full") {
      // Context is a capacity constraint, not a way to win the benchmark by
      // shrinking the slot. Only probe larger values and let safety/score
      // choose a higher context when its throughput cost is acceptable.
      add({ ...current, context: Math.floor(current.context * 1.5) });
    }
    if (profile.hybridMoe) {
      for (const direction of [-1, 1]) {
        add({
          ...current,
          cpuMoeLayers: clamp(
            current.cpuMoeLayers + direction * steps.cpuMoeLayers,
            0,
            maxCpuMoeLayers,
          ),
        });
      }
    } else {
      for (const direction of [-1, 1]) {
        add({
          ...current,
          fitTargetMiB: clamp(
            current.fitTargetMiB + direction * steps.fitTargetMiB,
            256,
            Math.max(512, Math.floor(totalVramMiB * 0.95)),
          ),
        });
      }
    }

    const measurements = [];
    for (const neighbour of neighbours) {
      const result = await measure(neighbour);
      if (result) measurements.push(result);
      if (results.length >= budget) break;
    }
    const bestNeighbour = measurements
      .filter((result) => result.ok)
      .sort((left, right) => right.score - left.score)[0];
    if (bestNeighbour && (!currentResult.ok || bestNeighbour.score > currentResult.score)) {
      current = {
        offloadMode: bestNeighbour.offloadMode,
        cpuMoeLayers: bestNeighbour.cpuMoeLayers,
        fitTargetMiB: bestNeighbour.fitTargetMiB,
        batchSize: bestNeighbour.batchSize,
        ubatchSize: bestNeighbour.ubatchSize,
        threads: bestNeighbour.threads,
        cacheTypeK: bestNeighbour.cacheTypeK,
        cacheTypeV: bestNeighbour.cacheTypeV,
        flashAttention: bestNeighbour.flashAttention,
        context: bestNeighbour.context,
      };
      currentResult = bestNeighbour;
      continue;
    }
    const reducible = Object.entries(steps).filter(([, value]) => value > 1);
    if (!reducible.length) break;
    for (const [name, value] of reducible) steps[name] = Math.max(1, Math.floor(value / 2));
  }
  return results;
}
