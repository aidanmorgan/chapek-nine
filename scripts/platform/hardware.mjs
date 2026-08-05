import os from "node:os";
import { spawnSync } from "node:child_process";

function command(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function nvidiaMemory() {
  const line = command("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"])
    .split(/\r?\n/)[0];
  if (!line) return null;
  const [name, totalMiB, usedMiB, freeMiB] = line.split(",").map((value) => value.trim());
  if (![totalMiB, usedMiB, freeMiB].every((value) => Number.isFinite(Number(value)))) return null;
  return { kind: "discrete", backend: "cuda", name, totalMiB: Number(totalMiB), usedMiB: Number(usedMiB), freeMiB: Number(freeMiB) };
}

function macHardware() {
  const memoryBytes = Number(command("sysctl", ["-n", "hw.memsize"])) || os.totalmem();
  const chip = command("sysctl", ["-n", "machdep.cpu.brand_string"]) || os.cpus()[0]?.model || "Apple Silicon";
  const graphics = command("system_profiler", ["SPDisplaysDataType", "-json"]);
  let gpuName = chip;
  try {
    const display = JSON.parse(graphics).SPDisplaysDataType?.[0] || {};
    gpuName = display.sppci_model || display._name || gpuName;
  } catch {}
  // Apple Silicon has a single physical memory pool. Reporting that as
  // discrete VRAM would double-count it in calibration; its availability is
  // monitored through OS free-memory samples instead.
  return {
    platform: "darwin",
    cpu: chip,
    totalRamBytes: memoryBytes,
    logicalCpus: os.cpus().length,
    gpu: { kind: "unified", backend: "metal", name: gpuName, totalMiB: null, usedMiB: null, freeMiB: null },
  };
}

export function probeHardware() {
  if (process.platform === "darwin") return macHardware();
  const gpu = nvidiaMemory();
  return {
    platform: process.platform,
    cpu: os.cpus()[0]?.model || "unknown",
    totalRamBytes: os.totalmem(),
    logicalCpus: os.cpus().length,
    gpu,
  };
}

export function sampleAcceleratorMemory() {
  return process.platform === "darwin" ? null : nvidiaMemory();
}
