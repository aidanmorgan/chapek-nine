import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.resolve(process.argv[2] || path.join(root, "runtime"));
const output = path.resolve(process.argv[3] || path.join(runtime, "quantization-report.json"));
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
const calibration = read(path.join(runtime, "calibration.json"), { profiles: {} });
const evals = read(path.join(runtime, "routing-evals.json"), { rows: [] });
const profiles = read(path.join(root, "config", "profiles.json"), { profiles: {} }).profiles;

const aggregates = new Map();
for (const row of evals.rows || []) {
  const item = aggregates.get(row.model) || { samples: 0, quality: 0, utility: 0, generationTps: 0, tpsSamples: 0, failures: 0 };
  item.samples += 1; item.quality += Number(row.score || 0); item.utility += Number(row.utility || 0);
  if (Number.isFinite(row.generationTps)) { item.generationTps += row.generationTps; item.tpsSamples += 1; }
  if (row.error) item.failures += 1;
  aggregates.set(row.model, item);
}
const variants = Object.entries(profiles).map(([model, profile]) => {
  const measured = aggregates.get(model);
  const bench = calibration.profiles?.[model]?.benchmark || {};
  const quality = measured ? measured.quality / measured.samples : null;
  const utility = measured ? measured.utility / measured.samples : null;
  const decodeTps = measured?.tpsSamples ? measured.generationTps / measured.tpsSamples : Number(bench.generationTps) || null;
  return {
    model, quantization: profile.quant || "unknown", source: profile.repo || null,
    calibrated: Boolean(calibration.profiles?.[model]), samples: measured?.samples || 0,
    quality, utility, decodeTps, failures: measured?.failures || 0,
    minFreeVramMiB: Number(bench.minFreeVramMiB) || null,
  };
}).sort((a, b) => (b.utility ?? -Infinity) - (a.utility ?? -Infinity) || (b.decodeTps ?? -Infinity) - (a.decodeTps ?? -Infinity));
const report = { version: 1, generatedAt: new Date().toISOString(), method: "Measured routing quality/utility and decode throughput; unmeasured variants are retained but never ranked above measured variants.", variants };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, measuredVariants: variants.filter((x) => x.samples).length, variants }, null, 2));
