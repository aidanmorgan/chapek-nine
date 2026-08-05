import { sameArtifact } from "./model-readiness.ts";

/** Returns true only when a measured report describes the currently loaded artifacts. */
export function hasCurrentEvaluationEvidence(report, currentArtifacts) {
  return (
    Array.isArray(report?.models) &&
    report.models.length > 0 &&
    report.models.every((id) => sameArtifact(report.modelArtifacts?.[id], currentArtifacts[id]))
  );
}
