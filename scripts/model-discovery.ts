import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const queries = ["coder GGUF", "code instruct GGUF", "programming GGUF"];
export function rankCandidates(rows) {
  return rows
    .map((row) => ({
      id: row.id,
      author: row.author || null,
      downloads: Number(row.downloads || 0),
      likes: Number(row.likes || 0),
      updatedAt: row.lastModified || null,
      tags: row.tags || [],
      score: Math.round(
        Math.log10(1 + Number(row.downloads || 0)) * 100 + Math.min(50, Number(row.likes || 0)),
      ),
    }))
    .sort((a, b) => b.score - a.score || b.downloads - a.downloads || a.id.localeCompare(b.id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, limitText = "50"] = process.argv.slice(2);
  if (!outputPath) throw new Error("Usage: model-discovery.ts <output.json> [limit]");
  const limit = Math.max(1, Math.min(200, Number(limitText) || 50));
  const found = new Map();
  const errors = [];
  for (const search of queries) {
    try {
      const endpoint = `https://huggingface.co/api/models?search=${encodeURIComponent(search)}&limit=${limit}&full=true`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        errors.push(`${search}: HTTP ${response.status}`);
        continue;
      }
      for (const item of await response.json()) {
        const tags = item.tags || [];
        if (tags.some((tag) => /gguf/i.test(tag)) || /gguf/i.test(item.id || ""))
          found.set(item.id, item);
      }
    } catch (error) {
      errors.push(`${search}: ${error.message}`);
    }
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    queries,
    candidates: rankCandidates([...found.values()]),
    errors,
  };
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ outputPath, candidates: report.candidates.length, errors }, null, 2),
  );
}
