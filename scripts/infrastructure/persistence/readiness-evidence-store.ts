import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./json-file.ts";

/** Filesystem implementation of the readiness evidence-store port. */
export function createFilesystemReadinessEvidenceStore({
  exists = fs.existsSync,
  readJson = readJsonFile,
} = {}) {
  return {
    loadCalibration(runtimeDir) {
      return readJson(path.join(runtimeDir, "calibration.json"), { profiles: {} });
    },
    loadModelEvidence({ id, modelsDir, runtimeDir }) {
      const modelDir = path.join(modelsDir, id);
      const manifest = readJson(path.join(modelDir, "manifest.json"), null);
      return {
        manifest,
        verification: readJson(path.join(runtimeDir, "verification", `${id}.json`), null),
        capability: readJson(path.join(runtimeDir, "capabilities", `${id}.json`), null),
        artifactFilesPresent: Boolean(
          manifest?.files?.every((file) => exists(path.join(modelDir, file.path))),
        ),
      };
    },
  };
}
