import { decideModelReadiness } from "../domain/model-readiness.ts";

/**
 * Application service that assembles immutable evidence for the readiness
 * policy. The evidence store is an injected port; filesystem concerns stay
 * in infrastructure.
 */
export function buildReadiness({ profiles, modelsDir, runtimeDir, evidenceStore }) {
  if (!evidenceStore) throw new Error("A readiness evidence store is required.");
  const calibration = evidenceStore.loadCalibration(runtimeDir);
  return Object.entries(profiles.profiles).map(([id, profile]) => {
    const evidence = evidenceStore.loadModelEvidence({ id, modelsDir, runtimeDir });
    const decision = decideModelReadiness({
      profile,
      manifest: evidence.manifest,
      verification: evidence.verification,
      calibration: calibration.profiles?.[id],
      capability: evidence.capability,
      artifactFilesPresent: evidence.artifactFilesPresent,
    });
    return { id, ...decision };
  });
}
