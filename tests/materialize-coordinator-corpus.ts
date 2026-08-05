import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DuckDBConnection } from "@duckdb/node-api";

const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-nine-corpus-"));
const example = (id, taskId, role) => ({
  id,
  taskId,
  category: "typescript",
  messages: [
    { role: "system", content: "route" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: JSON.stringify({
        version: 1,
        tier: "simple",
        primary: { role, model: "qwen-coder", maxTokens: 96 },
        steps: [],
        confidence: 0.9,
      }),
    },
  ],
});

try {
  fs.writeFileSync(
    path.join(directory, "train.jsonl"),
    `${JSON.stringify(example("train", "family-train", "implementer"))}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "validation.jsonl"),
    `${JSON.stringify(example("validation", "family-validation", "reviewer"))}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({ suiteVersion: 1 })}\n`,
  );
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "materialize-coordinator-corpus.ts"), directory],
    { stdio: "pipe" },
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "parquet-manifest.json"), "utf8"),
  );
  assert.equal(manifest.trainRows, 1);
  assert.equal(manifest.validationRows, 1);
  assert.equal(manifest.taskFamilyOverlap, 0);
  const connection = await DuckDBConnection.create();
  try {
    const result = await connection.runAndReadAll(
      `SELECT primary_model, max_tokens FROM read_parquet('${path.join(directory, "train.parquet").replaceAll("\\", "/")}')`,
    );
    assert.deepEqual(result.getRowObjects(), [{ primary_model: "qwen-coder", max_tokens: 96 }]);
  } finally {
    connection.closeSync();
  }
  console.log("TypeScript DuckDB corpus materialization test passed.");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
