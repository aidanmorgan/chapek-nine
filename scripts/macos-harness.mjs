#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeHardware } from "./platform/hardware.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command = "help", profileArgument, value] = process.argv.slice(2);
const configPath = path.join(root, "config", "profiles.json");
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const runtimeDir = path.resolve(process.env.KIMI_RUNTIME_DIR || path.join(root, "runtime"));
const logsDir = path.join(runtimeDir, "logs");
const statePath = path.join(runtimeDir, ".state.json");
const port = Number(process.env.KIMI_ROUTER_PORT || 8080);
const proxyPort = Number(process.env.KIMI_PROXY_PORT || 8090);

function run(exe, args, options = {}) { execFileSync(exe, args, { cwd: root, stdio: "inherit", ...options }); }
function output(exe, args) { const result = spawnSync(exe, args, { encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : ""; }
function profiles() { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
function selected(name = profileArgument) { const config = profiles(); const id = name || config.default; const profile = config.profiles[id]; if (!profile) throw new Error(`Unknown profile '${id}'. Run ./harness.sh profiles.`); return { id, profile }; }
function model(id) {
  const manifestPath = path.join(modelsDir, id, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = manifest.files?.map((file) => path.join(modelsDir, id, file.path)) || [];
  return files.length && files.every(fs.existsSync) ? { manifest, manifestPath, path: files[0] } : null;
}
function llama(binary) {
  const configured = process.env[`KIMI_LLAMA_${binary.toUpperCase()}`];
  if (configured && fs.existsSync(configured)) return configured;
  const executable = `llama-${binary}`;
  const found = output("sh", ["-lc", `command -v ${executable}`]);
  if (!found) throw new Error(`${executable} is missing. Run ./harness.sh setup.`);
  return found;
}
function ensureMac() { if (process.platform !== "darwin" && process.env.CHAPEK_ALLOW_UNSUPPORTED_PLATFORM !== "1") throw new Error("harness.sh is for macOS. Use harness.ps1 on Windows."); }
function offloadArgs(entry) {
  // Metal uses the same upstream fit/CPU-MoE controls. The calibration result
  // is shared because it is bound to this machine identity and manifest.
  const calibration = readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} }).profiles?.[entry.id]?.selected || {};
  const mode = calibration.offloadMode || entry.profile.offloadMode || "auto";
  if (mode === "partial-cpu-moe") return ["--fit", "off", "-ngl", "all", "--n-cpu-moe", String(calibration.cpuMoeLayers ?? entry.profile.cpuMoeLayers ?? 0)];
  if (mode === "cpu-moe") return ["--fit", "off", "-ngl", "all", "--cpu-moe"];
  return ["--fit", "on", "--fit-target", String(calibration.fitTargetMiB ?? 1536)];
}
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function presets() {
  const config = profiles(); const lines = ["version = 1", "", "[*]", "jinja = true", "parallel = 1", "cache-prompt = true", `slot-save-path = ${path.join(runtimeDir, "kv-cache")}`, ""];
  for (const [id, profile] of Object.entries(config.profiles)) {
    const local = model(id); if (!profile.supported || !local) continue;
    const cal = readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} }).profiles?.[id]?.selected || {};
    lines.push(`[${id}]`, `model = ${local.path}`, `ctx-size = ${cal.context || profile.context || 4096}`, `batch-size = ${cal.batchSize || 512}`, `ubatch-size = ${cal.ubatchSize || 256}`, `threads = ${cal.threads || Math.max(1, Math.floor(os.cpus().length / 2))}`, `cache-type-k = ${cal.cacheTypeK || profile.cacheTypeK || "q8_0"}`, `cache-type-v = ${cal.cacheTypeV || profile.cacheTypeV || "q8_0"}`, `flash-attn = ${cal.flashAttention === false ? "off" : "on"}`);
    const args = offloadArgs({ id, profile }); for (let index = 0; index < args.length; index += 2) lines.push(`${args[index].replace(/^-+/, "").replace("ngl", "n-gpu-layers")} = ${args[index + 1] || "true"}`);
    lines.push("load-on-startup = false", "");
  }
  const file = path.join(runtimeDir, "models.ini"); fs.mkdirSync(runtimeDir, { recursive: true }); fs.writeFileSync(file, `${lines.join("\n")}\n`); return file;
}
function setup() { ensureMac(); run("bash", [path.join(root, "scripts", "install-llama-macos.sh")]); run("npm", ["install", "--ignore-scripts"]); }
function download(entry) { if (!entry.profile.supported) throw new Error(`${entry.id} is capability-gated: ${entry.profile.notes}`); run("node", [path.join(root, "scripts", "download-hf.mjs"), entry.profile.repo, entry.profile.quant, path.join(modelsDir, entry.id)]); }
function verify(entry) {
  const local = model(entry.id); if (!local) throw new Error(`${entry.id} is not downloaded.`);
  const cli = llama("cli"); const args = ["-m", local.path, "--jinja", "--prompt", "Reply with exactly: LOCAL METAL OK", "--predict", "12", "--single-turn", "--no-display-prompt", ...offloadArgs(entry)];
  const result = spawnSync(cli, args, { encoding: "utf8" }); const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const passed = result.status === 0 && /^\s*LOCAL METAL OK\s*$/m.test(text);
  writeJson(path.join(runtimeDir, "verification", `${entry.id}.json`), { version: 1, profile: entry.id, modelPath: local.path, verifiedAt: new Date().toISOString(), backend: "metal", passed, exitCode: result.status, expected: "(?m)^\\s*LOCAL METAL OK\\s*$", outputTail: text.slice(-4000), artifact: local.manifest });
  if (!passed) throw new Error(`Metal inference verification failed for ${entry.id}; inspect runtime/verification/${entry.id}.json.`);
  console.log(`Metal inference verification passed for ${entry.id}.`);
}
function calibrate(entry, mode = "quick") { const local = model(entry.id); if (!local) throw new Error(`${entry.id} is not downloaded.`); stop(); run("node", [path.join(root, "scripts", "calibrate.mjs"), llama("bench"), local.path, entry.id, configPath, path.join(runtimeDir, "calibration.json"), mode, local.manifestPath]); }
async function start(entry) {
  const local = model(entry.id); if (!local) throw new Error(`${entry.id} is not downloaded.`); stop(); const preset = presets(); fs.mkdirSync(logsDir, { recursive: true });
  const server = spawn(llama("server"), ["--models-dir", modelsDir, "--models-preset", preset, "--no-models-autoload", "--host", "127.0.0.1", "--port", String(port)], { detached: true, stdio: ["ignore", fs.openSync(path.join(logsDir, "llama-server.log"), "a"), fs.openSync(path.join(logsDir, "llama-server.err.log"), "a")] }); server.unref();
  await health(`http://127.0.0.1:${port}/health`); await fetch(`http://127.0.0.1:${port}/models/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: local.manifest.modelId }) });
  const env = { ...process.env, LLAMA_BASE_URL: `http://127.0.0.1:${port}`, KIMI_PROXY_PORT: String(proxyPort), KIMI_KV_CACHE_DIR: path.join(runtimeDir, "kv-cache"), KIMI_MODELS_DIR: modelsDir, CHAPEK_READINESS_PATH: path.join(runtimeDir, "readiness.json") };
  const proxy = spawn("node", [path.join(root, "scripts", "model-proxy.mjs")], { detached: true, env, stdio: ["ignore", fs.openSync(path.join(logsDir, "model-proxy.log"), "a"), fs.openSync(path.join(logsDir, "model-proxy.err.log"), "a")] }); proxy.unref(); await health(`http://127.0.0.1:${proxyPort}/health`); writeJson(statePath, { pid: server.pid, proxyPid: proxy.pid, port, proxyPort, profile: entry.id, started: new Date().toISOString() }); console.log(`Chapek Nine front door ready at http://127.0.0.1:${proxyPort}/v1`);
}
async function health(url) { for (let count = 0; count < 60; count += 1) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 1000)); } throw new Error(`${url} did not become healthy; inspect ${logsDir}.`); }
function stop() { const state = readJson(statePath); for (const pid of [state?.proxyPid, state?.pid]) { if (Number.isInteger(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} } } try { fs.unlinkSync(statePath); } catch {} }
function doctor() { const hardware = probeHardware(); console.log(JSON.stringify({ platform: hardware.platform, cpu: hardware.cpu, ramGiB: Math.round(hardware.totalRamBytes / 2 ** 30 * 10) / 10, accelerator: hardware.gpu, llamaServer: output("sh", ["-lc", "command -v llama-server"] ) || null, node: process.version, modelsDir, runtimeDir }, null, 2)); }
async function probe(entry) { const local = model(entry.id); if (!local) throw new Error(`${entry.id} is not downloaded.`); await start(entry); run("node", [path.join(root, "scripts", "probe-model.mjs"), local.manifest.modelId, path.join(runtimeDir, "capabilities", `${entry.id}.json`), local.manifestPath, String(entry.profile.context || 4096)], { env: { ...process.env, LLAMA_BASE_URL: `http://127.0.0.1:${port}` } }); }
function readiness() { run("node", [path.join(root, "scripts", "application", "generate-readiness-report.mjs"), root, modelsDir, runtimeDir, path.join(runtimeDir, "readiness.json")]); }
function pi(entry) { start(entry).then(() => { const piDir = path.join(runtimeDir, "pi-agent"); fs.mkdirSync(piDir, { recursive: true }); const context = (readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} }).profiles?.[entry.id]?.selected?.context || entry.profile.context || 4096); writeJson(path.join(piDir, "models.json"), { providers: { "llama-local": { baseUrl: `http://127.0.0.1:${proxyPort}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "chapek-nine", name: "Chapek Nine", input: ["text"], contextWindow: context + 4096, maxTokens: Math.min(2048, context), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }); run(path.join(root, "node_modules", ".bin", "pi"), ["--approve", "--provider", "llama-local", "--model", "chapek-nine", "--api-key", "local"], { env: { ...process.env, PI_CODING_AGENT_DIR: piDir } }); }).catch((error) => { console.error(error.message); process.exitCode = 1; }); }

ensureMac();
const usage = "Usage: ./harness.sh <setup|init|doctor|profiles|download|download-all|verify|verify-all|calibrate|calibrate-all|probe|readiness|start|stop|pi> [profile] [quick|full]";
if (command === "help") console.log(usage);
else if (command === "setup") setup();
else if (command === "doctor") doctor();
else if (command === "profiles") Object.entries(profiles().profiles).forEach(([id, item]) => console.log(`${id}\t${item.supported ? "supported" : "capability-gated"}\t${item.displayName}`));
else if (command === "stop") stop();
else if (command === "download") download(selected());
else if (command === "verify") verify(selected());
else if (command === "calibrate") calibrate(selected(), value || "quick");
else if (command === "probe") await probe(selected());
else if (command === "readiness") readiness();
else if (command === "start") await start(selected());
else if (command === "pi") pi(selected());
else if (["download-all", "verify-all", "calibrate-all", "init"].includes(command)) { if (command === "init") setup(); for (const [id, profile] of Object.entries(profiles().profiles)) { if (!profile.supported) continue; const entry = selected(id); if (command === "download-all" || command === "init") download(entry); if (command === "verify-all" || command === "init") verify(entry); if (command === "calibrate-all" || command === "init") calibrate(entry, value || "full"); if (command === "init") await probe(entry); } if (command === "init") { readiness(); await start(selected()); } }
else throw new Error(usage);
