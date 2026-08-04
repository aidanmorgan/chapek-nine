import fs from "node:fs";
import path from "node:path";
import { taskText } from "./deterministic-router.mjs";

export function switchBrief(messages, limit = 5000) {
  const relevant = (messages || []).filter((message) => ["user", "assistant", "tool"].includes(message?.role));
  return taskText(relevant).slice(-limit);
}

export function saveTaskState(dir, id, model, messages, response) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const transcript = switchBrief(messages);
  const files = [...transcript.matchAll(/(?:^|[\s`])([\w./\\-]+\.(?:js|mjs|ts|tsx|py|ps1|rs|go|java|cs|json|ya?ml))/g)].map((match) => match[1]).slice(-30);
  const commands = [...transcript.matchAll(/(?:^|\n)tool:\s*([^\n]+)/g)].map((match) => match[1]).slice(-12);
  const value = { version: 2, updatedAt: new Date().toISOString(), model, taskBrief: transcript, files, commands, responseBrief: String(response || "").slice(-3000) };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(value)}\n`);
}

export function loadTaskState(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")); } catch { return null; }
}
