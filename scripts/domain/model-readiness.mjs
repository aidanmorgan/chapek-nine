import fs from "node:fs";
import path from "node:path";

/**
 * Model-readiness bounded context.
 *
 * This is deliberately a pure policy: it decides whether a configured worker
 * is safe to admit from immutable configuration plus measured evidence. File
 * layout and command-line concerns belong to the application layer.
 */
export function decideModelReadiness({ profile, manifest, verification, calibration, capability }) {
  const reasons = [];
  if (!profile.supported) reasons.push("capability-gated");
  const files = manifest?.files?.map((file) => file.path) || [];
  const manifestValid = manifest?.repo === profile.repo && manifest?.quant === profile.quant && files.length > 0;
  if (!manifestValid) reasons.push("verified-manifest-missing");
  const calibrated = Boolean(calibration?.selected);
  if (!calibrated) reasons.push("calibration-missing");
  const verified = verification?.passed === true;
  if (!verified) reasons.push("cuda-verification-missing-or-failed");
  const capable = capability?.passed === true;
  if (!capable) reasons.push("capability-probe-missing-or-failed");
  return { supported: Boolean(profile.supported), manifestValid, calibrated, verification: verified, capability: capable, eligible: reasons.length === 0, reasons };
}

export function buildReadiness({ profiles, modelsDir, runtimeDir, readJson = defaultReadJson, exists = fs.existsSync }) {
  const calibration = readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} });
  return Object.entries(profiles.profiles).map(([id, profile]) => {
    const modelDir = path.join(modelsDir, id);
    const manifest = readJson(path.join(modelDir, "manifest.json"), null);
    const decision = decideModelReadiness({
      profile,
      manifest,
      verification: readJson(path.join(runtimeDir, "verification", `${id}.json`), null),
      calibration: calibration.profiles?.[id],
      capability: readJson(path.join(runtimeDir, "capabilities", `${id}.json`), null),
    });
    // A manifest is only evidence if every listed immutable GGUF exists.
    if (decision.manifestValid && !manifest.files.every((file) => exists(path.join(modelDir, file.path)))) {
      decision.manifestValid = false;
      decision.eligible = false;
      decision.reasons.unshift("verified-manifest-missing");
    }
    return { id, ...decision };
  });
}

function defaultReadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
