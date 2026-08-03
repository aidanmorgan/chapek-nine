import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = path.join(root, "training", "corpus", "v1");
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, "manifest.json"), "utf8"));
const lines = (name) => fs.readFileSync(path.join(corpus, name), "utf8").trim().split("\n").map(JSON.parse);
const train = lines("train.jsonl");
const validation = lines("validation.jsonl");
assert.equal(train.length, manifest.trainRows);
assert.equal(validation.length, manifest.validationRows);
const trainFamilies = new Set(train.map((row) => row.taskId));
const validationFamilies = new Set(validation.map((row) => row.taskId));
assert.equal([...trainFamilies].filter((id) => validationFamilies.has(id)).length, 0);
for (const [name, expected] of Object.entries(manifest.files)) {
  const content = fs.readFileSync(path.join(corpus, name));
  assert.equal(content.length, expected.bytes);
  assert.equal(crypto.createHash("sha256").update(content).digest("hex"), expected.sha256);
}
console.log("versioned training corpus tests passed");
