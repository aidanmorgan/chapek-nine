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
  const value = { version: 1, updatedAt: new Date().toISOString(), model, taskBrief: switchBrief(messages), responseBrief: String(response || "").slice(-3000) };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(value)}\n`);
}

export function loadTaskState(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")); } catch { return null; }
}
