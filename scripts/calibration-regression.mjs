import fs from "node:fs";
import path from "node:path";

const [calibrationPath, profile, thresholdText = "0.12"] = process.argv.slice(2);
if (!calibrationPath || !profile) throw new Error("Usage: calibration-regression.mjs <calibration.json> <profile> [threshold]");
const calibration = JSON.parse(fs.readFileSync(calibrationPath, "utf8"));
const historyPath = path.join(path.dirname(calibrationPath), "calibration-history.jsonl");
const history = fs.existsSync(historyPath)
  ? fs.readFileSync(historyPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  : [];
const current = calibration.profiles?.[profile];
const prior = [...history].reverse().find(
  (row) => row.profile === profile && row.benchmark?.generationTps &&
    row.benchmark.generationTps !== calibration.profiles?.[profile]?.benchmark?.generationTps,
);
if (!current?.benchmark?.generationTps) throw new Error(`No calibration benchmark exists for '${profile}'.`);
const result = { profile, current: current.benchmark, prior: prior?.benchmark || null, regression: false };
if (prior) {
  const drop = 1 - current.benchmark.generationTps / prior.benchmark.generationTps;
  result.generationDrop = drop;
  result.regression = drop > Number(thresholdText);
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.regression ? 2 : 0;
