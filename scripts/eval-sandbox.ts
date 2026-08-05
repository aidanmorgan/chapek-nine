import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [fixture = "node-unit", candidatePath] = process.argv.slice(2);
const timeoutMs = Number(process.env.CHAPEK_SANDBOX_TIMEOUT_MS || 30_000);
const source = path.join(root, "evals", "sandbox-fixtures", fixture);
const manifestPath = path.join(source, "sandbox.json");
if (!fs.existsSync(manifestPath)) throw new Error(`Unknown sandbox fixture '${fixture}'.`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.command) || !manifest.command.length)
  throw new Error("Sandbox fixture requires a command array.");
const destination = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-nine-eval-"));
fs.cpSync(source, destination, { recursive: true });
if (candidatePath) {
  const candidate = path.resolve(candidatePath);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    throw new Error(`Candidate must be a readable file: ${candidate}`);
  const target = path.resolve(destination, manifest.candidate || path.basename(candidate));
  if (!target.startsWith(`${destination}${path.sep}`))
    throw new Error("Fixture candidate target escapes its workspace.");
  fs.copyFileSync(candidate, target);
}
const started = performance.now();
const command =
  manifest.command[0] === "tsx"
    ? path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx")
    : manifest.command[0];
const child = spawn(command, manifest.command.slice(1), {
  cwd: destination,
  windowsHide: true,
  shell: process.platform === "win32" && command.endsWith(".cmd"),
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const timer = setTimeout(() => child.kill(), timeoutMs);
const code = await new Promise((resolve) => child.once("close", resolve));
clearTimeout(timer);
// The temp directory is deliberately preserved on failure so a failed model
// answer can be inspected. This runner is isolation for reproducibility, not
// a security boundary for untrusted native code.
const result = {
  fixture,
  candidate: candidatePath ? path.resolve(candidatePath) : null,
  command: manifest.command,
  exitCode: code,
  passed: code === 0,
  timeoutMs,
  elapsedMs: Math.round(performance.now() - started),
  workspace: destination,
  stdout: stdout.slice(-4000),
  stderr: stderr.slice(-4000),
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
