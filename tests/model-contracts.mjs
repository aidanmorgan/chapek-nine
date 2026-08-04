import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdapter } from "../scripts/model-adapters.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const profiles = json("config/profiles.json");
const adapters = json("config/model-adapters.json");
const routing = json("config/orchestration.json");

assert.ok(profiles.profiles[profiles.default]?.supported, "the default worker must be supported");
for (const [id, profile] of Object.entries(profiles.profiles)) {
  if (!profile.supported) continue;
  assert.ok(profile.repo, `${id} needs a GGUF repository`);
  assert.ok(profile.quant, `${id} needs a quantization selector`);
  assert.ok(Number(profile.context) > 0, `${id} needs a positive context`);
  assert.ok(profile.offloadMode, `${id} needs an offload strategy`);
  assert.ok(
    profile.admission === undefined || ["public", "specialist"].includes(profile.admission),
    `${id} has an invalid admission tier`,
  );
  assert.ok(adapters.models[id], `${id} needs an explicit protocol adapter`);
  const adapter = resolveAdapter(adapters, id);
  assert.ok(adapter.systemMode, `${id} adapter needs a system-message policy`);
  assert.ok(adapter.toolMode, `${id} adapter needs a tool-call policy`);
}

const routed = new Set([
  ...routing.coordinator,
  ...routing.synthesizer,
  ...Object.values(routing.roles).flat(),
]);
for (const id of routed) {
  assert.ok(profiles.profiles[id]?.supported, `routing refers to unsupported or unknown worker ${id}`);
  assert.ok(adapters.models[id], `routing worker ${id} has no explicit adapter`);
}

console.log("model contracts: ok");
