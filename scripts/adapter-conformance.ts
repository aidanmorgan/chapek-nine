import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptRequest, resolveAdapter } from "./model-adapters.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profiles = JSON.parse(fs.readFileSync(path.join(root, "config", "profiles.json"), "utf8"));
const adapters = JSON.parse(
  fs.readFileSync(path.join(root, "config", "model-adapters.json"), "utf8"),
);
const rows = [];
for (const [model, profile] of Object.entries(profiles.profiles)) {
  if (!profile.supported) continue;
  const adapted = adaptRequest(
    {
      model: "chapek-nine",
      messages: [
        { role: "developer", content: "Follow conventions." },
        { role: "user", content: "Return JSON." },
      ],
      max_completion_tokens: 128,
      tools: [
        { type: "function", function: { name: "read/file", parameters: { type: "object" } } },
      ],
    },
    model,
    resolveAdapter(adapters, model),
    profile.context,
  );
  assert.equal(adapted.model, model);
  assert.ok(adapted.messages.length);
  assert.equal(adapted.max_completion_tokens, undefined);
  rows.push({
    model,
    toolMode: resolveAdapter(adapters, model).toolMode || "native",
    status: "pass",
  });
}
console.log(JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), rows }, null, 2));
