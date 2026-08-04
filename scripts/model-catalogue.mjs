import fs from "node:fs";
import path from "node:path";
const [output, ...repos] = process.argv.slice(2);
if (!output || !repos.length) throw new Error("Usage: model-catalogue.mjs <output.json> <owner/repo>...");
const rows = [];
for (const repo of repos) {
  const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true&expand=false`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) { rows.push({ repo, error: response.status }); continue; }
  const files = (await response.json()).filter((file) => /\.gguf$/i.test(file.path)).map((file) => ({ path: file.path, bytes: file.size || null }));
  rows.push({ repo, discoveredAt: new Date().toISOString(), gguf: files });
}
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify({ version: 1, rows }, null, 2)}\n`);
console.log(output);
