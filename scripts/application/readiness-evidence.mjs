import fs from "node:fs";
import path from "node:path";
import { decideModelReadiness } from "../domain/model-readiness.mjs";

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

/** Application service that assembles immutable filesystem evidence for the readiness policy. */
export function buildReadiness({ profiles, modelsDir, runtimeDir, exists = fs.existsSync }) {
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
    if (decision.manifestValid && !manifest.files.every((file) => exists(path.join(modelDir, file.path)))) {
      decision.manifestValid = false;
      decision.publicEligible = false;
      decision.specialistEligible = false;
      decision.publicReasons.unshift("verified-manifest-missing");
      decision.specialistReasons.unshift("verified-manifest-missing");
    }
    return { id, ...decision };
  });
}
