import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLlamaRuntime } from "../../llama-runtime.ts";
import { probeHardware } from "../../../platform/hardware.ts";

/** Windows implementation of the same platform port consumed by chapek-command-core. */
export function createWindowsPlatform({ root, modelsDir, runtimeDir, profilesPath }) {
  const statePath = process.env.KIMI_RUNTIME_DIR
    ? path.join(runtimeDir, ".state.json")
    : path.join(root, ".state.json");
  const port = Number(process.env.KIMI_ROUTER_PORT || 8080);
  const run = (exe, args, options = {}) =>
    execFileSync(exe, args, { cwd: root, stdio: "inherit", windowsHide: true, ...options });
  const output = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const where = (name) => output("where.exe", [name]).split(/\r?\n/)[0];
  const findRuntimeExecutable = (directory, name) => {
    if (!fs.existsSync(directory)) return null;
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, child.name);
      if (child.isFile() && child.name.toLowerCase() === name.toLowerCase()) return candidate;
      if (child.isDirectory()) {
        const found = findRuntimeExecutable(candidate, name);
        if (found) return found;
      }
    }
    return null;
  };
  const llama = (binary) => {
    const variable = `KIMI_LLAMA_${binary.toUpperCase()}`;
    const configured = process.env[variable];
    if (configured && fs.existsSync(configured)) return configured;
    const configuredDir = process.env.KIMI_LLAMA_DIR;
    const candidate = configuredDir && path.join(configuredDir, `llama-${binary}.exe`);
    if (candidate && fs.existsSync(candidate)) return candidate;
    const installed = findRuntimeExecutable(
      path.join(runtimeDir, "llama.cpp"),
      `llama-${binary}.exe`,
    );
    if (installed) return installed;
    const found = where(`llama-${binary}.exe`) || where(`llama-${binary}`);
    if (!found)
      throw new Error(`llama-${binary}.exe is missing. Run scripts/windows-harness.ts setup.`);
    return found;
  };
  const runtime = createLlamaRuntime({
    root,
    modelsDir,
    runtimeDir,
    profilesPath,
    statePath,
    lineEnding: "\r\n",
    llama,
    spawnOptions: { windowsHide: true },
    kill: (pid) => {
      try {
        process.kill(pid);
      } catch {}
    },
  });
  const { offload, waitHealth, readJson, writeJson, stop, start, piDirectory, logsDir } = runtime;
  const startCoordinator = async () => {
    const config = readJson(path.join(root, "config", "coordinator.json"));
    const directory = path.join(modelsDir, "coordinator");
    let manifest = readJson(path.join(directory, "manifest.json"));
    if (
      !manifest ||
      manifest.repo !== config.base.repo ||
      manifest.quant !== config.base.quant ||
      !manifest.files?.length ||
      !fs.existsSync(path.join(directory, manifest.files[0].path))
    ) {
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "download-hf.ts"),
        config.base.repo,
        config.base.quant,
        directory,
      ]);
      manifest = readJson(path.join(directory, "manifest.json"));
    }
    const base = path.join(directory, manifest.files[0].path);
    const adapter = path.join(runtimeDir, config.adapter);
    if (!fs.existsSync(adapter))
      throw new Error("Coordinator adapter is missing; train-coordinator first.");
    const coordinatorPort = Number(process.env.CHAPEK_COORDINATOR_PORT || 8081);
    const state = readJson(statePath, {});
    if (Number.isInteger(state.coordinatorPid)) {
      try {
        await waitHealth(`http://127.0.0.1:${coordinatorPort}/health`);
        return;
      } catch {
        try {
          process.kill(state.coordinatorPid);
        } catch {}
      }
    }
    const process = spawn(
      llama("server"),
      [
        "-m",
        base,
        "-a",
        adapter,
        "--host",
        "127.0.0.1",
        "--port",
        String(coordinatorPort),
        "--ctx-size",
        String(config.context || 2048),
        "-ngl",
        "0",
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: [
          "ignore",
          fs.openSync(path.join(logsDir, "coordinator.log"), "a"),
          fs.openSync(path.join(logsDir, "coordinator.err.log"), "a"),
        ],
      },
    );
    process.unref();
    await waitHealth(`http://127.0.0.1:${coordinatorPort}/health`);
    writeJson(statePath, { ...state, coordinatorPid: process.pid });
  };
  return {
    fileExists: fs.existsSync,
    readFile: (file) => fs.readFileSync(file, "utf8"),
    usage: () =>
      "Usage: node scripts/windows-harness.ts <setup|init|doctor|profiles|onboard <name> <owner/repo> <quant>|download|download-all|verify|verify-all|calibrate|calibrate-all|probe|readiness|evals|train-coordinator|evaluate-coordinator|await-evals|smoke|start|stop|pi> [profile] [quick|full]",
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
            llamaServer: (() => {
              try {
                return llama("server");
              } catch {
                return null;
              }
            })(),
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
      run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "install-llama.ps1"),
        "-Cuda",
        "12.4",
      ]);
      run("npm.cmd", ["install", "--ignore-scripts"]);
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
          "Reply with exactly: LOCAL CUDA OK",
          "--predict",
          "12",
          "--single-turn",
          "--no-display-prompt",
          ...offload(item),
        ],
        { encoding: "utf8", windowsHide: true },
      );
      const text = `${result.stdout || ""}\n${result.stderr || ""}`;
      const passed = result.status === 0 && /^\s*LOCAL CUDA OK\s*$/m.test(text);
      writeJson(path.join(runtimeDir, "verification", `${item.id}.json`), {
        version: 1,
        profile: item.id,
        modelPath: local.path,
        verifiedAt: new Date().toISOString(),
        backend: "cuda",
        passed,
        exitCode: result.status,
        expected: "(?m)^\\s*LOCAL CUDA OK\\s*$",
        outputTail: text.slice(-4000),
        artifact: local.manifest,
      });
      if (!passed) throw new Error(`CUDA inference verification failed for ${item.id}.`);
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
        localTraining: true,
        localEvaluation: true,
        reason: "Windows CUDA QLoRA coordinator is available after its CUDA/Python preflight.",
      };
    },
    reportCoordinatorFallback(capability) {
      console.log(`Coordinator fallback: ${capability.reason}`);
      return { mode: "deterministic", reason: capability.reason };
    },
    async trainCoordinator() {
      run(process.execPath, [
        "--import",
        "tsx",
        path.join(root, "scripts", "infrastructure", "os", "windows", "train-coordinator.ts"),
        root,
        modelsDir,
        runtimeDir,
      ]);
    },
    async evaluateCoordinator({ startup, local }) {
      await start(startup, local);
      await startCoordinator();
      const data = path.join(runtimeDir, "coordinator", "data");
      if (!fs.existsSync(path.join(data, "validation.jsonl")))
        throw new Error("Coordinator validation data is missing; train-coordinator first.");
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "scripts", "evaluate-coordinator.ts"),
          data,
          path.join(runtimeDir, "coordinator-eval.json"),
        ],
        {
          env: {
            ...process.env,
            CHAPEK_COORDINATOR_URL: `http://127.0.0.1:${Number(process.env.CHAPEK_COORDINATOR_PORT || 8081)}`,
          },
        },
      );
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
        path.join(root, "node_modules", ".bin", "pi.cmd"),
        ["--approve", "--provider", "llama-local", "--model", "chapek-nine", "--api-key", "local"],
        { env: { ...process.env, PI_CODING_AGENT_DIR: piDirectory(item) } },
      );
    },
    async smoke(item, local) {
      await start(item, local);
      run(
        path.join(root, "node_modules", ".bin", "pi.cmd"),
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
        { env: { ...process.env, PI_CODING_AGENT_DIR: piDirectory(item) } },
      );
    },
  };
}
