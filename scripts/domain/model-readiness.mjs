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
  const artifact = artifactIdentity(manifest);
  const calibrated = Boolean(calibration?.selected) && sameArtifact(calibration?.artifact, artifact);
  if (!calibrated) reasons.push("calibration-missing");
  const verified = verification?.passed === true && sameArtifact(verification?.artifact, artifact);
  if (!verified) reasons.push("cuda-verification-missing-or-failed");
  const capable = capability?.passed === true && sameArtifact(capability?.artifact, artifact);
  if (!capable) reasons.push("capability-probe-missing-or-failed");
  return { supported: Boolean(profile.supported), manifestValid, calibrated, verification: verified, capability: capable, eligible: reasons.length === 0, reasons };
}

export function artifactIdentity(manifest) {
  if (!manifest?.repo || !manifest?.quant || !manifest?.modelId || !Array.isArray(manifest.files)) return null;
  return { repo: manifest.repo, quant: manifest.quant, modelId: manifest.modelId, files: manifest.files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size: Number(size || 0), sha256: sha256 || null })).sort((a, b) => a.path.localeCompare(b.path)) };
}

export function sameArtifact(left, right) {
  const canonicalLeft = artifactIdentity(left) || left;
  const canonicalRight = artifactIdentity(right) || right;
  return JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight) && canonicalLeft !== null;
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
