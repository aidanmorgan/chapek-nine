import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadTaskState,
  saveTaskState,
  statePrompt,
  switchBrief,
  taskStateFromMessages,
} from "../scripts/context-state.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chapek-state-"));
const messages = [
  { role: "system", content: "hidden" },
  { role: "user", content: "Fix src/main.py. You must preserve the public API.\nPS> npm test" },
  { role: "tool", name: "shell", content: "npm test\nAssertionError: expected 2" },
];
assert.match(switchBrief(messages), /Fix src\/main.py/);
const semantic = taskStateFromMessages(messages, "I found the failing assertion.");
assert.deepEqual(semantic.files, ["src/main.py"]);
assert.match(statePrompt(semantic), /preserve the public API/);
assert.match(statePrompt(semantic), /AssertionError/);
saveTaskState(dir, "session", "worker-a", messages, "I found the failing assertion.");
assert.equal(loadTaskState(dir, "session").model, "worker-a");
fs.rmSync(dir, { recursive: true, force: true });
console.log("context state tests passed");
