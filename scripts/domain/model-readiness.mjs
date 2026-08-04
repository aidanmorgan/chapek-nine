/**
 * Model-readiness bounded context.
 *
 * This is deliberately a pure policy: it decides whether a configured worker
 * is safe to admit from immutable configuration plus measured evidence. File
 * layout and command-line concerns belong to the application layer.
 */
export function decideModelReadiness({ profile, manifest, verification, calibration, capability }) {
  const commonReasons = [];
  if (!profile.supported) commonReasons.push("capability-gated");
  const files = manifest?.files?.map((file) => file.path) || [];
  const manifestValid = manifest?.repo === profile.repo && manifest?.quant === profile.quant && files.length > 0;
  if (!manifestValid) commonReasons.push("verified-manifest-missing");
  const artifact = artifactIdentity(manifest);
  const calibrated = Boolean(calibration?.selected) && sameArtifact(calibration?.artifact, artifact);
  if (!calibrated) commonReasons.push("calibration-missing");
  const verified = verification?.passed === true && sameArtifact(verification?.artifact, artifact);
  if (!verified) commonReasons.push("cuda-verification-missing-or-failed");
  const capabilityCurrent = sameArtifact(capability?.artifact, artifact);
  const publicCapability = capability?.passed === true && capabilityCurrent;
  const specialistCapability = capabilityCurrent &&
    capability?.capability?.json_schema === true &&
    capability?.capability?.streaming === true;
  const publicReasons = [...commonReasons];
  if (!publicCapability) publicReasons.push("public-capability-probe-missing-or-failed");
  const specialistReasons = [...commonReasons];
  if (!specialistCapability) specialistReasons.push("specialist-capability-probe-missing-or-failed");
  return {
    supported: Boolean(profile.supported),
    manifestValid,
    calibrated,
    verification: verified,
    publicCapability,
    specialistCapability,
    publicEligible: publicReasons.length === 0,
    specialistEligible: specialistReasons.length === 0,
    publicReasons,
    specialistReasons,
  };
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
