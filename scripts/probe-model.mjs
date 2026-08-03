import fs from "node:fs";
import path from "node:path";

const [model, outputPath] = process.argv.slice(2);
if (!model || !outputPath) throw new Error("Usage: probe-model.mjs <model-id> <output.json>");
const baseUrl = (process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const headers = { "Content-Type": "application/json" };
if (process.env.LLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.LLAMA_API_KEY}`;
async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
const started = performance.now();
await request("/models/load", { method: "POST", body: JSON.stringify({ model }) });
const result = await request("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "system", content: "Reply only with valid JSON." }, { role: "user", content: "Return {\"ok\":true}." }], temperature: 0, max_tokens: 32, response_format: { type: "json_object" } }) });
const text = result.choices?.[0]?.message?.content || "";
let jsonReliable = false;
try { jsonReliable = JSON.parse(text).ok === true; } catch {}
const probe = { version: 1, model, probedAt: new Date().toISOString(), jsonReliable, response: text, promptTps: result.timings?.prompt_per_second || null, generationTps: result.timings?.predicted_per_second || null, latencyMs: Math.round(performance.now() - started), notes: "Tool calling and long-context behavior require the compatibility suite before enabling a new worker." };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(probe, null, 2)}\n`);
console.log(JSON.stringify(probe, null, 2));
