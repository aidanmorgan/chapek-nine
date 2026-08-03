import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExpandedTaskFamilies } from "./developer-task-suite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = JSON.parse(
  fs.readFileSync(path.join(root, "evals", "developer-routing.json"), "utf8"),
);
const zScore = 1.96;
const assumedProportion = 0.5;
const marginOfError = 0.1;
const holdoutFamiliesPerRole = Math.ceil(
  (zScore ** 2 * assumedProportion * (1 - assumedProportion)) / marginOfError ** 2,
);
const generated = buildExpandedTaskFamilies();
const suite = {
  version: 3,
  coreTaskCount: core.tasks.length,
  generatedTaskCount: generated.length,
  tasks: [...core.tasks, ...generated],
  sampling: {
    confidenceLevel: 0.95,
    zScore,
    assumedProportion,
    marginOfError,
    formula: "ceil(z^2 * p * (1-p) / margin^2)",
    holdoutFamiliesPerRole,
    split: "whole task families are held out, stratified by routing role",
    note: "The confidence target applies to aggregate role-level routing comparisons. Per-pattern and per-language results remain diagnostic slices, not independently powered significance tests.",
  },
};
const output = path.join(root, "evals", "developer-routing-full.json");
fs.writeFileSync(output, `${JSON.stringify(suite, null, 2)}\n`);
console.log(JSON.stringify({ output, taskFamilies: suite.tasks.length, holdoutFamiliesPerRole }, null, 2));
