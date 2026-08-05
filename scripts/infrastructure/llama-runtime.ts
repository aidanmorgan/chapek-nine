import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared lifecycle adapter for the local llama server and the Chapek Nine proxy.
 * Platform ports supply only executable discovery and process-specific options.
 */
export function createLlamaRuntime({
  root,
  modelsDir,
  runtimeDir,
  profilesPath,
  statePath,
  lineEnding = "\n",
  spawnOptions = {},
  kill,
  llama,
}) {
  const logsDir = path.join(runtimeDir, "logs");
  const port = Number(process.env.KIMI_ROUTER_PORT || 8080);
  const proxyPort = Number(process.env.KIMI_PROXY_PORT || 8090);
  const readJson = (file, fallback = null) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const calibration = (id) =>
    readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} }).profiles?.[id]
      ?.selected || {};
  const offload = (item) => {
    const value = calibration(item.id);
    const mode = value.offloadMode || item.profile.offloadMode || "auto";
    if (mode === "partial-cpu-moe")
      return [
        "--fit",
        "off",
        "-ngl",
        "all",
        "--n-cpu-moe",
        String(value.cpuMoeLayers ?? item.profile.cpuMoeLayers ?? 0),
      ];
    if (mode === "cpu-moe") return ["--fit", "off", "-ngl", "all", "--cpu-moe"];
    return ["--fit", "on", "--fit-target", String(value.fitTargetMiB ?? 1536)];
  };
  const waitHealth = async (url) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`${url} did not become healthy; inspect ${logsDir}.`);
  };
  const writePresets = () => {
    const config = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
    const lines = [
      "version = 1",
      "",
      "[*]",
      "jinja = true",
      "parallel = 1",
      "cache-prompt = true",
      `slot-save-path = ${path.join(runtimeDir, "kv-cache")}`,
      "",
    ];
    for (const [id, profile] of Object.entries(config.profiles)) {
      const manifest = readJson(path.join(modelsDir, id, "manifest.json"));
      if (
        !profile.supported ||
        !manifest?.files?.length ||
        manifest.repo !== profile.repo ||
        manifest.quant !== profile.quant
      )
        continue;
      const modelPath = path.join(modelsDir, id, manifest.files[0].path);
      if (!fs.existsSync(modelPath)) continue;
      const value = calibration(id);
      lines.push(
        `[${id}]`,
        `model = ${modelPath}`,
        `ctx-size = ${value.context || profile.context || 4096}`,
        `batch-size = ${value.batchSize || 512}`,
        `ubatch-size = ${value.ubatchSize || 256}`,
        `threads = ${value.threads || Math.max(1, Math.floor(os.cpus().length / 2))}`,
        `cache-type-k = ${value.cacheTypeK || profile.cacheTypeK || "q8_0"}`,
        `cache-type-v = ${value.cacheTypeV || profile.cacheTypeV || "q8_0"}`,
        `flash-attn = ${value.flashAttention === false ? "off" : "on"}`,
      );
      const args = offload({ id, profile });
      for (let index = 0; index < args.length; index += 2)
        lines.push(
          `${args[index].replace(/^-+/, "").replace("ngl", "n-gpu-layers")} = ${args[index + 1] || "true"}`,
        );
      lines.push("load-on-startup = false", "");
    }
    const file = path.join(runtimeDir, "models.ini");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(file, `${lines.join(lineEnding)}${lineEnding}`);
    return file;
  };
  const stop = () => {
    const state = readJson(statePath);
    for (const pid of [state?.proxyPid, state?.coordinatorPid, state?.pid])
      if (Number.isInteger(pid)) kill(pid);
    try {
      fs.unlinkSync(statePath);
    } catch {}
  };
  const openLog = (name) => fs.openSync(path.join(logsDir, name), "a");
  const start = async (item, local) => {
    if (!local) throw new Error("start requires a resolved artifact");
    stop();
    const preset = writePresets();
    fs.mkdirSync(logsDir, { recursive: true });
    const server = spawn(
      llama("server"),
      [
        "--models-dir",
        modelsDir,
        "--models-preset",
        preset,
        "--no-models-autoload",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        detached: true,
        ...spawnOptions,
        stdio: ["ignore", openLog("llama-server.log"), openLog("llama-server.err.log")],
      },
    );
    server.unref();
    await waitHealth(`http://127.0.0.1:${port}/health`);
    await fetch(`http://127.0.0.1:${port}/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: local.manifest.modelId }),
    });
    const proxy = spawn(
      process.execPath,
      ["--import", "tsx", path.join(root, "scripts", "model-proxy.ts")],
      {
        detached: true,
        ...spawnOptions,
        env: {
          ...process.env,
          LLAMA_BASE_URL: `http://127.0.0.1:${port}`,
          KIMI_PROXY_PORT: String(proxyPort),
          KIMI_KV_CACHE_DIR: path.join(runtimeDir, "kv-cache"),
          KIMI_MODELS_DIR: modelsDir,
          CHAPEK_READINESS_PATH: path.join(runtimeDir, "readiness.json"),
        },
        stdio: ["ignore", openLog("model-proxy.log"), openLog("model-proxy.err.log")],
      },
    );
    proxy.unref();
    await waitHealth(`http://127.0.0.1:${proxyPort}/health`);
    writeJson(statePath, {
      pid: server.pid,
      proxyPid: proxy.pid,
      port,
      proxyPort,
      profile: item.id,
      started: new Date().toISOString(),
    });
  };
  const piDirectory = (item) => {
    const directory = path.join(runtimeDir, "pi-agent");
    fs.mkdirSync(directory, { recursive: true });
    const context = calibration(item.id).context || item.profile.context || 4096;
    writeJson(path.join(directory, "models.json"), {
      providers: {
        "llama-local": {
          baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
          api: "openai-completions",
          apiKey: "local",
          models: [
            {
              id: "chapek-nine",
              name: "Chapek Nine",
              input: ["text"],
              contextWindow: context + 4096,
              maxTokens: Math.min(2048, context),
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });
    return directory;
  };
  return {
    calibration,
    offload,
    waitHealth,
    writePresets,
    readJson,
    writeJson,
    stop,
    start,
    piDirectory,
    logsDir,
    statePath,
    port,
  };
}
