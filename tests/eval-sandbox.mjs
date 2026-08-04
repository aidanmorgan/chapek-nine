import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-sandbox-test-"));
const good = path.join(dir, "good.mjs"); const bad = path.join(dir, "bad.mjs");
fs.writeFileSync(good, "export const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));\n");
fs.writeFileSync(bad, "export const clamp=(v)=>v;\n");
for (const [candidate, passed] of [[good, true], [bad, false]]) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "eval-sandbox.mjs"), "node-unit", candidate], { encoding: "utf8" });
  assert.equal(result.status === 0, passed, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, passed);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log("eval sandbox: ok");
