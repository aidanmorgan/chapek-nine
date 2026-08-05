import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hashFile = (file) =>
  fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : null;
export function decision({ adapterExists, inputs, previous }) {
  if (!adapterExists) return { action: "improve", reason: "no coordinator adapter is installed" };
  if (!previous?.inputHash) return { action: "improve", reason: "no prior autopilot evaluation" };
  if (previous.inputHash !== inputs.inputHash)
    return { action: "improve", reason: "routing evaluation or training corpus changed" };
  if (!previous.accepted) return { action: "improve", reason: "previous promotion was rejected" };
  return { action: "hold", reason: "promoted coordinator matches current inputs" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeDir, command = "check", acceptedText] = process.argv.slice(2);
  if (!runtimeDir)
    throw new Error("Usage: coordinator-autopilot.ts <runtime-dir> <check|record> [accepted]");
  const runtime = path.resolve(runtimeDir);
  const statePath = path.join(runtime, "coordinator-autopilot.json");
  const inputs = {
    routingEvals: hashFile(path.join(runtime, "routing-evals.json")),
    corpusManifest: hashFile(path.join("training", "corpus", "v1", "manifest.json")),
    coordinatorConfig: hashFile(path.join("config", "coordinator.json")),
  };
  inputs.inputHash = crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  if (command === "check") {
    const adapterExists = fs.existsSync(path.join(runtime, "coordinator", "chapek-nine-lora.gguf"));
    console.log(JSON.stringify({ inputs, ...decision({ adapterExists, inputs, previous }) }));
  } else if (command === "record") {
    const value = {
      version: 1,
      updatedAt: new Date().toISOString(),
      inputHash: inputs.inputHash,
      inputs,
      accepted: acceptedText === "true",
    };
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`);
    console.log(JSON.stringify(value));
  } else throw new Error(`Unknown autopilot command '${command}'.`);
}
