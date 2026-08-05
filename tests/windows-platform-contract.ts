import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsPlatform } from "../scripts/infrastructure/os/windows/platform.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = createWindowsPlatform({
  root,
  modelsDir: path.join(root, "models"),
  runtimeDir: path.join(root, "runtime"),
  profilesPath: path.join(root, "config", "profiles.json"),
});
for (const method of [
  "fileExists",
  "readFile",
  "help",
  "doctor",
  "showProfiles",
  "profileOnboarded",
  "setup",
  "download",
  "verify",
  "calibrate",
  "probe",
  "adapterConformance",
  "generateReadiness",
  "evaluate",
  "coordinatorCapability",
  "reportCoordinatorFallback",
  "trainCoordinator",
  "evaluateCoordinator",
  "waitForRoutingEvaluation",
  "start",
  "stop",
  "pi",
  "smoke",
])
  assert.equal(typeof platform[method], "function", `missing ${method}`);
assert.match(platform.usage(), /windows-harness/);
console.log("windows platform port contract passed");
