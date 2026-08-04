import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
export function buildReadiness({ profiles, modelsDir, runtimeDir }) {
  const calibration = readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} });
  return Object.entries(profiles.profiles).map(([id, profile]) => {
    const reasons = [];
    if (!profile.supported) reasons.push("capability-gated");
    const modelDir = path.join(modelsDir, id);
    const manifest = readJson(path.join(modelDir, "manifest.json"), null);
    const files = manifest?.files?.map((file) => path.join(modelDir, file.path)) || [];
    const manifestValid = manifest?.repo === profile.repo && manifest?.quant === profile.quant && files.length > 0 && files.every(fs.existsSync);
    if (!manifestValid) reasons.push("verified-manifest-missing");
    const verification = readJson(path.join(runtimeDir, "verification", `${id}.json`), null);
    if (verification?.passed !== true) reasons.push("cuda-verification-missing-or-failed");
    const calibrated = Boolean(calibration.profiles?.[id]?.selected);
    if (!calibrated) reasons.push("calibration-missing");
    const capability = readJson(path.join(runtimeDir, "capabilities", `${id}.json`), null);
    if (capability?.passed !== true) reasons.push("capability-probe-missing-or-failed");
    return { id, supported: Boolean(profile.supported), manifestValid, verification: verification?.passed === true, calibrated, capability: capability?.passed === true, eligible: reasons.length === 0, reasons };
  });
}

const [rootDir, modelsDir, runtimeDir, outputPath] = process.argv.slice(2);
if (rootDir && modelsDir && runtimeDir && outputPath) {
  const root = path.resolve(rootDir); const profiles = readJson(path.join(root, "config", "profiles.json"), { profiles: {} });
  const models = buildReadiness({ profiles, modelsDir: path.resolve(modelsDir), runtimeDir: path.resolve(runtimeDir) });
  const report = { version: 1, generatedAt: new Date().toISOString(), models, eligible: models.filter((item) => item.eligible).map((item) => item.id) };
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true }); fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, eligible: report.eligible, blocked: models.filter((item) => !item.eligible).map((item) => ({ id: item.id, reasons: item.reasons })) }, null, 2));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) throw new Error("Usage: readiness.mjs <root> <models-dir> <runtime-dir> <output.json>");
