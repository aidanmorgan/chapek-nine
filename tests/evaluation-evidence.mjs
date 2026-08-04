import assert from "node:assert/strict";
import { hasCurrentEvaluationEvidence } from "../scripts/domain/evaluation-evidence.mjs";

const artifact = { repo: "org/model", quant: "Q4", modelId: "worker", files: [{ path: "model.gguf", size: 1, sha256: "a" }] };
const report = { models: ["worker"], modelArtifacts: { worker: artifact } };
assert.equal(hasCurrentEvaluationEvidence(report, { worker: artifact }), true);
assert.equal(hasCurrentEvaluationEvidence(report, { worker: { ...artifact, quant: "Q5" } }), false);
assert.equal(hasCurrentEvaluationEvidence({ models: ["worker"] }, { worker: artifact }), false);
console.log("evaluation evidence: ok");
