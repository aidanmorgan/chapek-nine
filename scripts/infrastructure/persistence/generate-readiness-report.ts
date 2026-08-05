import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReadiness } from "../../application/readiness-evidence.ts";
import { readJsonFile } from "./json-file.ts";
import { createFilesystemReadinessEvidenceStore } from "./readiness-evidence-store.ts";

/**
 * Filesystem/CLI adapter for the readiness-report use case. The application
 * service itself remains free of filesystem and process concerns.
 */
export function generateReadinessReport({ rootDir, modelsDir, runtimeDir, outputPath }) {
  const profiles = readJsonFile(path.join(rootDir, "config", "profiles.json"), { profiles: {} });
  const models = buildReadiness({
    profiles,
    modelsDir,
    runtimeDir,
    evidenceStore: createFilesystemReadinessEvidenceStore(),
  });
  const report = {
    version: 2,
    generatedAt: new Date().toISOString(),
    models,
    publicEligible: models.filter((item) => item.publicEligible).map((item) => item.id),
    specialistEligible: models.filter((item) => item.specialistEligible).map((item) => item.id),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const [rootDir, modelsDir, runtimeDir, outputPath] = process.argv.slice(2);
if (rootDir && modelsDir && runtimeDir && outputPath) {
  const report = generateReadinessReport({
    rootDir: path.resolve(rootDir),
    modelsDir: path.resolve(modelsDir),
    runtimeDir: path.resolve(runtimeDir),
    outputPath: path.resolve(outputPath),
  });
  console.log(
    JSON.stringify(
      {
        outputPath,
        publicEligible: report.publicEligible,
        specialistEligible: report.specialistEligible,
        blocked: report.models
          .filter((item) => !item.publicEligible)
          .map(({ id, publicReasons }) => ({ id, reasons: publicReasons })),
      },
      null,
      2,
    ),
  );
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error(
    "Usage: generate-readiness-report.ts <root> <models-dir> <runtime-dir> <output.json>",
  );
}
