import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChapekCommandCore } from "../scripts/application/chapek-command-core.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-core-"));
const models = path.join(root, "models"); const runtime = path.join(root, "runtime"); fs.mkdirSync(path.join(models, "worker"), { recursive: true });
fs.writeFileSync(path.join(root, "profiles.json"), JSON.stringify({ default: "worker", profiles: { worker: { supported: true, repo: "owner/repo", quant: "Q4" } } }));
fs.writeFileSync(path.join(models, "worker", "model.gguf"), "x"); fs.writeFileSync(path.join(models, "worker", "manifest.json"), JSON.stringify({ repo: "owner/repo", quant: "Q4", files: [{ path: "model.gguf" }] }));
const calls = []; const platform = { fileExists: fs.existsSync, readFile: (file) => fs.readFileSync(file, "utf8"), usage: () => "help", help() {}, doctor() {}, showProfiles() {}, async download() { calls.push("download"); }, async verify() { calls.push("verify"); }, async calibrate(_item, _local, mode) { calls.push(`calibrate:${mode}`); }, async probe() { calls.push("probe"); }, async adapterConformance() { calls.push("conformance"); }, async generateReadiness() { calls.push("readiness"); }, async evaluate(request) { calls.push(`evals:${request.mode}:${request.target?.id || "all"}`); }, async smoke() { calls.push("smoke"); }, async setup() { calls.push("setup"); }, async start() {}, stop() {}, async pi() {} };
const core = createChapekCommandCore({ root, platform, profilesPath: path.join(root, "profiles.json"), modelsDir: models, runtimeDir: runtime });
await core.execute("init");
assert.deepEqual(calls, ["setup", "conformance", "download", "verify", "calibrate:full", "probe", "readiness", "evals:full:all", "readiness", "smoke"]);
await core.execute("evals", "full");
await core.execute("evals", "worker", "quick");
assert.deepEqual(calls.slice(-2), ["evals:full:all", "evals:quick:worker"]);
fs.rmSync(root, { recursive: true, force: true }); console.log("command core tests passed");
