import fs from "node:fs";
import path from "node:path";

/**
 * Read JSON from a local persistence boundary, returning an explicit fallback
 * when the document does not exist or cannot be decoded.
 */
export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically so readers never observe a partially written document. */
export function writeJsonFileAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
