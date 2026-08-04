import os from "node:os";
import { execFileSync } from "node:child_process";

function gpu() {
  try {
    const line = execFileSync("nvidia-smi", ["--query-gpu=memory.total,memory.used,temperature.gpu,power.draw", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true })
      .trim().split(/\r?\n/)[0];
    const [totalMiB, usedMiB, temperatureC, powerW] = line.split(",").map((value) => Number(value.trim()));
    return { totalMiB, usedMiB, freeMiB: Math.max(0, totalMiB - usedMiB), temperatureC, powerW };
  } catch { return null; }
}

export function sampleResources() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  return { at: new Date().toISOString(), totalRamGiB: totalRam / 2 ** 30, freeRamGiB: freeRam / 2 ** 30, gpu: gpu() };
}

export function resourceDecision(sample, limits = {}) {
  const minRamGiB = Number(limits.minFreeRamGiB ?? Math.max(0.5, Number(sample.totalRamGiB || 0) * 0.04));
  const minVramMiB = Number(limits.minFreeVramMiB ?? Math.max(128, (sample.gpu?.totalMiB || 0) * 0.04));
  const maxTemperatureC = Number(limits.maxTemperatureC ?? 86);
  if (sample.freeRamGiB < minRamGiB) return { admit: false, reason: `free RAM ${sample.freeRamGiB.toFixed(1)} GiB is below ${minRamGiB} GiB` };
  if (sample.gpu?.freeMiB < minVramMiB) return { admit: false, reason: `free VRAM ${sample.gpu.freeMiB} MiB is below ${minVramMiB} MiB` };
  if (sample.gpu?.temperatureC >= maxTemperatureC) return { admit: false, reason: `GPU temperature ${sample.gpu.temperatureC}C is at the ${maxTemperatureC}C limit` };
  return { admit: true };
}

export async function waitForAdmission({ sample = sampleResources, limits = {}, timeoutMs = 300_000, intervalMs = 5_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = resourceDecision(sample(), limits);
  while (!latest.admit && /temperature/i.test(latest.reason || "") && Date.now() < deadline) {
    await sleep(intervalMs);
    latest = resourceDecision(sample(), limits);
  }
  return latest;
}

export function createRuntimeMetrics() {
  const state = { startedAt: new Date().toISOString(), requests: 0, failures: 0, routes: {}, cacheRestores: 0, cacheSaves: 0, recent: [] };
  return {
    state,
    record(route, elapsedMs, error) {
      state.requests += 1;
      if (error) state.failures += 1;
      if (route) state.routes[route] = (state.routes[route] || 0) + 1;
      state.recent.push({ at: new Date().toISOString(), route, elapsedMs: Math.round(elapsedMs), error: error || undefined });
      if (state.recent.length > 50) state.recent.shift();
    },
  };
}
