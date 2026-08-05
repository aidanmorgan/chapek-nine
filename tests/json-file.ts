import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "../scripts/infrastructure/persistence/json-file.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-json-file-"));
const file = path.join(directory, "nested", "value.json");

assert.equal(readJsonFile(file, null), null);
writeJsonFileAtomic(file, { retained: true, values: [1, 2, 3] });
assert.deepEqual(readJsonFile(file, null), { retained: true, values: [1, 2, 3] });
fs.writeFileSync(file, "not json");
assert.equal(readJsonFile(file, "fallback"), "fallback");
fs.rmSync(directory, { recursive: true, force: true });

console.log("json file persistence checks passed");
