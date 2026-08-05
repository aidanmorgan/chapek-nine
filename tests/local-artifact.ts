import assert from "node:assert/strict";
import { matchesConfiguredArtifact } from "../scripts/application/local-artifact.ts";

const profile = { repo: "owner/repo", quant: "Q4_K_M" };
const manifest = { repo: "owner/repo", quant: "Q4_K_M", files: [{ path: "worker.gguf" }] };
assert.equal(
  matchesConfiguredArtifact(profile, manifest, (file) => file === "worker.gguf"),
  true,
);
assert.equal(
  matchesConfiguredArtifact({ ...profile, quant: "Q5_K_M" }, manifest, () => true),
  false,
);
assert.equal(
  matchesConfiguredArtifact(profile, { ...manifest, repo: "other/repo" }, () => true),
  false,
);
assert.equal(
  matchesConfiguredArtifact(profile, manifest, () => false),
  false,
);
console.log("local artifact tests passed");
