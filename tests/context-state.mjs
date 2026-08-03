import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTaskState, saveTaskState, switchBrief } from "../scripts/context-state.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-state-"));
const messages = [{ role: "system", content: "hidden" }, { role: "user", content: "Fix the failing Python test." }, { role: "tool", content: "test failed" }];
assert.match(switchBrief(messages), /Fix the failing Python test/);
saveTaskState(dir, "session", "worker-a", messages, "I found the failing assertion.");
assert.equal(loadTaskState(dir, "session").model, "worker-a");
fs.rmSync(dir, { recursive: true, force: true });
console.log("context state tests passed");
