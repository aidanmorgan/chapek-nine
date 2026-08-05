import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLlamaRuntime } from "../../llama-runtime.ts";
import { probeHardware } from "../../../platform/hardware.ts";

export function createMacosPlatform({ root, modelsDir, runtimeDir, profilesPath }) {
  const statePath = path.join(runtimeDir, ".state.json");
  const run = (exe, args, options = {}) =>
    execFileSync(exe, args, { cwd: root, stdio: "inherit", ...options });
  const output = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const llama = (binary) => {
    const configured = process.env[`KIMI_LLAMA_${binary.toUpperCase()}`];
    if (configured && fs.existsSync(configured)) return configured;
    const found = output("sh", ["-lc", `command -v llama-${binary}`]);
    if (!found) throw new Error(`llama-${binary} is missing. Run ./harness.sh setup.`);
    return found;
  };
  const runtime = createLlamaRuntime({
    root,
    modelsDir,
    runtimeDir,
    profilesPath,
    statePath,
    llama,
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    },
  });
  const { offload, writeJson, stop, start, piDirectory: piDir, port } = runtime;
  return {
    fileExists: fs.existsSync,
    readFile: (file) => fs.readFileSync(file, "utf8"),
    usage: () =>
      "Usage: ./harness.sh <setup|init|doctor|profiles|onboard <name> <owner/repo> <quant>|download|download-all|verify|verify-all|calibrate|calibrate-all|probe|readiness|evals|train-coordinator|evaluate-coordinator|await-evals|smoke|start|stop|pi> [profile] [quick|full]",
    help() {
      console.log(this.usage());
    },
    showProfiles(config) {
      for (const [id, item] of Object.entries(config.profiles))
        console.log(
          `${id}\t${item.supported ? "supported" : "capability-gated"}\t${item.displayName}`,
        );
    },
    profileOnboarded({ name, repo, quant }) {
      console.log(
        `Onboarded ${name} (${repo}:${quant}). Run download, verify, calibrate, probe, and evals before admission.`,
      );
    },
    doctor({ modelsDir: modelDirectory, runtimeDir: dataDirectory }) {
      const hardware = probeHardware();
      console.log(
        JSON.stringify(
          {
            platform: hardware.platform,
            cpu: hardware.cpu,
            ramGiB: Math.round((hardware.totalRamBytes / 2 ** 30) * 10) / 10,
            accelerator: hardware.gpu,
            llamaServer: output("sh", ["-lc", "command -v llama-server"]) || null,
            node: process.version,
            modelsDir: modelDirectory,
            runtimeDir: dataDirectory,
          },
          null,
          2,
        ),
      );
    },
    async setup() {
      run("bash", [path.join(root, "scripts", "install-llama-macos.sh")]);
      run("npm", ["install", "--ignore-scripts"]);
    },
    async download(item, directory) {
      if (!item.profile.supported) throw new Error(`${item.id} is capability-gated.`);
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "download-hf.ts"),
        item.profile.repo,
        item.profile.quant,
        directory,
      ]);
    },
    async verify(item, local) {
      const result = spawnSync(
        llama("cli"),
        [
          "-m",
          local.path,
          "--jinja",
          "--prompt",
          "Reply with exactly: LOCAL METAL OK",
          "--predict",
          "12",
          "--single-turn",
          "--no-display-prompt",
          ...offload(item),
        ],
        { encoding: "utf8" },
      );
      const text = `${result.stdout || ""}\n${result.stderr || ""}`;
      const passed = result.status === 0 && /^\s*LOCAL METAL OK\s*$/m.test(text);
      writeJson(path.join(runtimeDir, "verification", `${item.id}.json`), {
        version: 1,
        profile: item.id,
        modelPath: local.path,
        verifiedAt: new Date().toISOString(),
        backend: "metal",
        passed,
        exitCode: result.status,
        expected: "(?m)^\\s*LOCAL METAL OK\\s*$",
        outputTail: text.slice(-4000),
        artifact: local.manifest,
      });
      if (!passed) throw new Error(`Metal inference verification failed for ${item.id}.`);
    },
    async calibrate(item, local, mode) {
      stop();
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "calibrate.ts"),
        llama("bench"),
        local.path,
        item.id,
        profilesPath,
        path.join(runtimeDir, "calibration.json"),
        mode,
        local.manifestPath,
      ]);
    },
    async probe(item, local) {
      await start(item, local);
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "scripts", "probe-model.ts"),
          local.manifest.modelId,
          path.join(runtimeDir, "capabilities", `${item.id}.json`),
          local.manifestPath,
          String(item.profile.context || 4096),
        ],
        { env: { ...process.env, LLAMA_BASE_URL: `http://127.0.0.1:${port}` } },
      );
    },
    async adapterConformance() {
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "adapter-conformance.ts"),
      ]);
    },
    async generateReadiness({
      root: rootDir,
      modelsDir: modelDirectory,
      runtimeDir: dataDirectory,
    }) {
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "infrastructure", "persistence", "generate-readiness-report.ts"),
        rootDir,
        modelDirectory,
        dataDirectory,
        path.join(dataDirectory, "readiness.json"),
      ]);
    },
    coordinatorCapability() {
      return {
        localTraining: false,
        localEvaluation: false,
        reason:
          "QLoRA coordinator training and serving require the supported Windows CUDA toolchain; deterministic routing remains active.",
      };
    },
    reportCoordinatorFallback(capability) {
      console.log(`Coordinator fallback: ${capability.reason}`);
      return { mode: "deterministic", reason: capability.reason };
    },
    async waitForRoutingEvaluation({ runtimeDir: dataDirectory }) {
      const report = path.join(dataDirectory, "routing-evals.json");
      while (!fs.existsSync(report)) await new Promise((resolve) => setTimeout(resolve, 30_000));
      return report;
    },
    async evaluate({ target, startup, local, mode }) {
      await start(startup, local);
      const args = [
        path.join(root, "scripts", "run-routing-evals.ts"),
        path.join(runtimeDir, "routing-evals.json"),
        mode,
      ];
      if (target) args.push(target.id);
      run(process.execPath, ["--import", "tsx", ...args], {
        env: {
          ...process.env,
          LLAMA_BASE_URL: `http://127.0.0.1:${port}`,
          KIMI_MODELS_DIR: modelsDir,
          KIMI_RUNTIME_DIR: runtimeDir,
        },
      });
    },
    async start(item, local) {
      await start(item, local);
    },
    stop,
    async pi(item, local) {
      await start(item, local);
      run(
        path.join(root, "node_modules", ".bin", "pi"),
        ["--approve", "--provider", "llama-local", "--model", "chapek-nine", "--api-key", "local"],
        { env: { ...process.env, PI_CODING_AGENT_DIR: piDir(item) } },
      );
    },
    async smoke(item, local) {
      await start(item, local);
      run(
        path.join(root, "node_modules", ".bin", "pi"),
        [
          "--approve",
          "--provider",
          "llama-local",
          "--model",
          "chapek-nine",
          "--api-key",
          "local",
          "--no-session",
          "--no-tools",
          "--print",
          "Reply with exactly: LOCAL PI OK",
        ],
        { env: { ...process.env, PI_CODING_AGENT_DIR: piDir(item) } },
      );
    },
  };
}
