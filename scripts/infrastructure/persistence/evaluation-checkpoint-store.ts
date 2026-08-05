import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

function compatible(left, right) {
  return isDeepStrictEqual(left, right);
}

/**
 * JSONL-backed resumable evaluation store. Checkpoint layout and atomic file
 * lifecycle are persistence concerns; the evaluator owns the evaluation flow.
 */
export function openEvaluationCheckpoint({ outputPath, identity }) {
  const checkpointPath = `${outputPath}.checkpoint.jsonl`;
  const rows = [];
  if (fs.existsSync(checkpointPath)) {
    const lines = fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/).filter(Boolean);
    const header = lines.length ? JSON.parse(lines.shift()) : null;
    if (
      !header ||
      header.kind !== "chapek-routing-evaluation-checkpoint" ||
      !compatible(header.identity, identity)
    ) {
      throw new Error(
        `Routing evaluation checkpoint is incompatible with the current suite or model artifacts: ${checkpointPath}`,
      );
    }
    for (const line of lines) rows.push(JSON.parse(line));
  } else {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(
      checkpointPath,
      `${JSON.stringify({ kind: "chapek-routing-evaluation-checkpoint", version: 1, identity })}\n`,
    );
  }
  const completed = new Set(
    rows.map((row) => `${row.model}\u0000${row.taskId}\u0000${row.maxTokens}`),
  );
  return {
    checkpointPath,
    rows,
    has(model, taskId, maxTokens) {
      return completed.has(`${model}\u0000${taskId}\u0000${maxTokens}`);
    },
    append(row) {
      const key = `${row.model}\u0000${row.taskId}\u0000${row.maxTokens}`;
      if (completed.has(key)) return;
      fs.appendFileSync(checkpointPath, `${JSON.stringify(row)}\n`);
      completed.add(key);
      rows.push(row);
    },
    complete() {
      fs.unlinkSync(checkpointPath);
    },
  };
}
