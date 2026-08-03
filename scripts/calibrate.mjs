import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptiveSearch } from "./calibration-search.mjs";

const [bench, modelPath, profileName, profilesPath, outputPath, mode = "quick"] =
  process.argv.slice(2);
if (!bench || !modelPath || !profileName || !profilesPath || !outputPath) {
  console.error(
    "Usage: node calibrate.mjs <llama-bench> <model> <profile> <profiles-json> <output> [quick|full]",
  );
  process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(profilesPath, "utf8")).profiles?.[
  profileName
];
if (!profile) throw new Error(`Unknown profile '${profileName}'.`);
const totalRam = os.totalmem();

function gpuMemory() {
  const result = spawnSync(
    "nvidia-smi",
    [
      "--query-gpu=memory.total,memory.used,memory.free",
      "--format=csv,noheader,nounits",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const values = result.stdout
    ?.trim()
    .split(",")
    .map((value) => Number(value.trim()));
  return values?.length === 3 && values.every(Number.isFinite)
    ? { totalMiB: values[0], usedMiB: values[1], freeMiB: values[2] }
    : null;
}

async function sampleGpu() {
  return await new Promise((resolve) => {
    const child = spawn(
      "nvidia-smi",
      [
        "--query-gpu=memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => {
      const values = stdout
        .trim()
        .split(",")
        .map((value) => Number(value.trim()));
      resolve(
        values.length === 3 && values.every(Number.isFinite)
          ? { totalMiB: values[0], usedMiB: values[1], freeMiB: values[2] }
          : null,
      );
    });
    child.on("error", () => resolve(null));
  });
}

async function runCandidate(candidate, index, count) {
  const args = [
    "-m",
    modelPath,
    "-o",
    "json",
    "-r",
    mode === "full" ? "2" : "1",
    "-p",
    mode === "full" ? "256" : "64",
    "-n",
    mode === "full" ? "64" : "16",
    "-b",
    String(candidate.batchSize),
    "-ub",
    String(candidate.ubatchSize),
    "-ctk",
    profile.cacheTypeK || "q8_0",
    "-ctv",
    profile.cacheTypeV || "q8_0",
    "-t",
    String(Math.max(1, os.cpus().length / 2)),
    "-fa",
    "on",
  ];
  if (candidate.offloadMode === "partial-cpu-moe") {
    args.push("-ngl", "999", "-ncmoe", String(candidate.cpuMoeLayers));
  } else {
    args.push("--fit-target", String(candidate.fitTargetMiB));
  }
  console.error(
    `[calibrate] ${index + 1}/${count} ${JSON.stringify(candidate)}`,
  );
  const started = Date.now();
  const initialFreeRam = os.freemem();
  const initialGpuForCandidate = gpuMemory();
  const child = spawn(bench, args, { windowsHide: true });
  let stdout = "";
  let stderr = "";
  let minFreeRam = os.freemem();
  let minFreeVram = Infinity;
  let maxUsedVram = 0;
  let unsafeReason = null;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // Do not treat memory already used by Codex/the desktop as model overhead.
  // On Windows, freemem() also excludes reclaimable mapped-file cache and can
  // briefly approach zero while llama.cpp is paging model tensors. Let the
  // benchmark/OOM path decide viability; this guard only catches a prolonged
  // system-wide collapse (32 MiB for 30 seconds).
  const hardRamFloor = 32 * 1024 ** 2;
  let lowRamPolls = 0;
  const monitor = setInterval(async () => {
    const freeRam = os.freemem();
    minFreeRam = Math.min(minFreeRam, freeRam);
    lowRamPolls = freeRam < hardRamFloor ? lowRamPolls + 1 : 0;
    const gpu = await sampleGpu();
    if (gpu) {
      minFreeVram = Math.min(minFreeVram, gpu.freeMiB);
      maxUsedVram = Math.max(maxUsedVram, gpu.usedMiB);
    }
    if (lowRamPolls >= 60 && !unsafeReason) {
      unsafeReason = `available RAM remained below ${(hardRamFloor / 1024 ** 3).toFixed(2)} GiB`;
      child.kill();
    }
  }, 500);
  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });
  clearInterval(monitor);
  if (exitCode !== 0 || unsafeReason) {
    return {
      ...candidate,
      ok: false,
      unsafeReason,
      exitCode,
      stderr: stderr.slice(-2000),
      elapsedSeconds: (Date.now() - started) / 1000,
      minFreeRamGiB: minFreeRam / 1024 ** 3,
      baselineFreeRamGiB: initialFreeRam / 1024 ** 3,
      minFreeVramMiB: Number.isFinite(minFreeVram) ? minFreeVram : null,
      maxUsedVramMiB: maxUsedVram || null,
      baselineUsedVramMiB: initialGpuForCandidate?.usedMiB ?? null,
    };
  }
  let rows;
  try {
    rows = JSON.parse(stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1));
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      exitCode,
      unsafeReason: `could not parse llama-bench output: ${error.message}`,
      stderr: stderr.slice(-2000),
    };
  }
  const prompt = rows.find((row) => row.n_prompt > 0);
  const generation = rows.find((row) => row.n_gen > 0);
  if (!prompt || !generation) {
    return { ...candidate, ok: false, unsafeReason: "missing benchmark rows" };
  }
  const promptTps = prompt.avg_ts;
  const generationTps = generation.avg_ts;
  const throughputScore = 1 / (0.25 / promptTps + 0.75 / generationTps);
  const incrementalRam = Math.max(0, initialFreeRam - minFreeRam);
  const osRamReserve = Math.max(4 * 1024 ** 3, totalRam * 0.12);
  const estimatedFreeRam = Math.max(0, totalRam - osRamReserve - incrementalRam);
  const incrementalVram = Math.max(
    0,
    maxUsedVram - (initialGpuForCandidate?.usedMiB || 0),
  );
  const desktopVramReserve = Math.max(
    512,
    (initialGpuForCandidate?.totalMiB || 0) * 0.04,
  );
  const estimatedFreeVram = Math.max(
    0,
    (initialGpuForCandidate?.totalMiB || 0) -
      desktopVramReserve -
      incrementalVram,
  );
  const headroomFactor =
    Math.min(1, estimatedFreeRam / (2 * 1024 ** 3)) *
    Math.min(1, estimatedFreeVram / 1024);
  return {
    ...candidate,
    ok: true,
    promptTps,
    generationTps,
    throughputScore,
    score: throughputScore * (0.75 + 0.25 * headroomFactor),
    elapsedSeconds: (Date.now() - started) / 1000,
    minFreeRamGiB: minFreeRam / 1024 ** 3,
    baselineFreeRamGiB: initialFreeRam / 1024 ** 3,
    incrementalRamGiB: incrementalRam / 1024 ** 3,
    estimatedFreeRamIgnoringHostLoadGiB: estimatedFreeRam / 1024 ** 3,
    minFreeVramMiB: Number.isFinite(minFreeVram) ? minFreeVram : null,
    maxUsedVramMiB: maxUsedVram || null,
    baselineUsedVramMiB: initialGpuForCandidate?.usedMiB ?? null,
    incrementalVramMiB: incrementalVram,
    estimatedFreeVramIgnoringHostLoadMiB: estimatedFreeVram,
  };
}

const initialGpu = gpuMemory();
const results = await adaptiveSearch({
  profile,
  totalRamGiB: totalRam / 1024 ** 3,
  totalVramMiB: initialGpu?.totalMiB ?? 0,
  mode,
  evaluate: runCandidate,
});
const successful = results.filter((result) => result.ok);
if (!successful.length) {
  console.error(JSON.stringify(results, null, 2));
  throw new Error("No safe calibration candidate completed.");
}
successful.sort((a, b) => b.score - a.score);
const best = successful[0];
const modelStat = fs.statSync(modelPath);
const existing = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, "utf8"))
  : { version: 1, profiles: {} };
existing.machine = {
  id: crypto
    .createHash("sha256")
    .update(`${os.hostname()}\0${os.cpus()[0]?.model}\0${totalRam}\0${initialGpu?.totalMiB}`)
    .digest("hex")
    .slice(0, 16),
  hostname: os.hostname(),
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  ramGiB: totalRam / 1024 ** 3,
  gpu: initialGpu,
};
existing.profiles ||= {};
existing.profiles[profileName] = {
  calibratedAt: new Date().toISOString(),
  mode,
  modelPath: path.resolve(modelPath),
  modelSizeBytes: modelStat.size,
  selected: {
    offloadMode: best.offloadMode,
    cpuMoeLayers: best.cpuMoeLayers,
    fitTargetMiB: best.fitTargetMiB,
    batchSize: best.batchSize,
    ubatchSize: best.ubatchSize,
    context: profile.context,
  },
  benchmark: {
    promptTps: best.promptTps,
    generationTps: best.generationTps,
    score: best.score,
    minFreeRamGiB: best.minFreeRamGiB,
    minFreeVramMiB: best.minFreeVramMiB,
    maxUsedVramMiB: best.maxUsedVramMiB,
  },
  candidates: results,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`);
fs.renameSync(temporary, outputPath);
console.log(JSON.stringify(existing.profiles[profileName], null, 2));
