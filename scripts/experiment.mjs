import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [command, runtimeDir, name, other] = process.argv.slice(2);
if (!command || !runtimeDir) throw new Error("Usage: experiment.mjs <record|compare> <runtime-dir> ...");
const experiments = path.join(runtimeDir, "experiments");
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
if (command === "record") {
  const run = { version: 1, name: name || `run-${Date.now()}`, recordedAt: new Date().toISOString(), machine: { hostname: os.hostname(), cpus: os.cpus()[0]?.model, ramBytes: os.totalmem() }, calibration: read(path.join(runtimeDir, "calibration.json")), routingEvals: read(path.join(runtimeDir, "routing-evals.json")) };
  run.id = crypto.createHash("sha256").update(JSON.stringify(run)).digest("hex").slice(0, 16);
  fs.mkdirSync(experiments, { recursive: true });
  const output = path.join(experiments, `${run.name}-${run.id}.json`);
  fs.writeFileSync(output, `${JSON.stringify(run, null, 2)}\n`);
  console.log(output);
} else if (command === "compare") {
  const a = read(path.resolve(name)); const b = read(path.resolve(other));
  if (!a || !b) throw new Error("Both experiment files must exist.");
  const profiles = [...new Set([...Object.keys(a.calibration?.profiles || {}), ...Object.keys(b.calibration?.profiles || {})])];
  console.log(JSON.stringify({ a: a.name, b: b.name, profiles: profiles.map((profile) => ({ profile, decodeTpsA: a.calibration?.profiles?.[profile]?.benchmark?.generationTps ?? null, decodeTpsB: b.calibration?.profiles?.[profile]?.benchmark?.generationTps ?? null })) }, null, 2));
} else throw new Error(`Unknown experiment command '${command}'.`);
