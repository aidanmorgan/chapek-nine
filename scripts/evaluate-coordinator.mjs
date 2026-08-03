import fs from "node:fs";
import path from "node:path";

const [dataDir, outputPath, limitText = "200"] = process.argv.slice(2);
if (!dataDir || !outputPath) throw new Error("Usage: evaluate-coordinator.mjs <data-dir> <output.json> [limit]");
const baseUrl = (process.env.CHAPEK_COORDINATOR_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");
const config = JSON.parse(fs.readFileSync(path.resolve("config/coordinator.json"), "utf8"));
const rows = fs.readFileSync(path.join(dataDir, "validation.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).slice(0, Number(limitText));
let valid = 0, exact = 0;
for (const row of rows) {
  const expected = JSON.parse(row.messages.at(-1).content).primary;
  const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: config.modelId, messages: row.messages.slice(0, -1), temperature: 0, max_tokens: config.maxTokens, stream: false }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) continue;
  try {
    const actual = JSON.parse((await response.json()).choices?.[0]?.message?.content || "{}").primary;
    if (actual?.model && actual?.role) valid += 1;
    if (actual?.model === expected.model && actual?.role === expected.role) exact += 1;
  } catch {}
}
const report = { version: 1, evaluatedAt: new Date().toISOString(), samples: rows.length, schemaValidRate: valid / rows.length, primaryExactRate: exact / rows.length, promotion: { minimumSchemaValidRate: 0.98, minimumPrimaryExactRate: 0.75, accepted: valid / rows.length >= 0.98 && exact / rows.length >= 0.75 } };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.promotion.accepted ? 0 : 2;
