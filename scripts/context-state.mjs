import fs from "node:fs";
import path from "node:path";
import { taskText } from "./deterministic-router.mjs";

const text = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || part?.content || "").join("\n") : "";
const uniqueTail = (values, limit) => [...new Set(values.filter(Boolean))].slice(-limit);

export function switchBrief(messages, limit = 5000) {
  const relevant = (messages || []).filter((message) => ["user", "assistant", "tool"].includes(message?.role));
  return taskText(relevant).slice(-limit);
}

export function taskStateFromMessages(messages, response) {
  const transcript = switchBrief(messages);
  const files = uniqueTail([...transcript.matchAll(/(?:^|[\s`])([\w./\\-]+\.(?:js|mjs|ts|tsx|py|ps1|rs|go|java|cs|json|ya?ml|md|toml))/g)].map((match) => match[1]), 40);
  const commands = uniqueTail((messages || []).flatMap((message) => {
    const value = text(message.content);
    if (message.role === "tool") return value.split(/\r?\n/).filter((line) => line.trim()).slice(0, 3);
    return [...value.matchAll(/(?:^|\n)\s*(?:PS>|\$|>)\s*([^\n]+)/g)].map((match) => match[1]);
  }), 20);
  const toolResults = (messages || []).filter((message) => message.role === "tool").slice(-8).map((message) => ({
    name: message.name || message.tool_call_id || "tool",
    result: text(message.content).slice(-1000),
  }));
  const constraints = uniqueTail((messages || []).filter((message) => message.role === "user").flatMap((message) =>
    text(message.content).split(/(?<=[.!?])\s+|\r?\n/).filter((line) => /\b(?:must|must not|should|do not|don't|require|only|avoid|never)\b/i.test(line)).map((line) => line.trim()),
  ), 16);
  return { taskBrief: transcript, files, commands, toolResults, constraints, responseBrief: String(response || "").slice(-3000) };
}

export function statePrompt(state, limit = 7500) {
  if (!state) return "";
  const sections = [
    state.taskBrief && `Task transcript:\n${state.taskBrief}`,
    state.files?.length && `Relevant files: ${state.files.join(", ")}`,
    state.constraints?.length && `Constraints:\n- ${state.constraints.join("\n- ")}`,
    state.commands?.length && `Executed commands:\n- ${state.commands.join("\n- ")}`,
    state.toolResults?.length && `Tool results:\n${state.toolResults.map((item) => `[${item.name}] ${item.result}`).join("\n")}`,
    state.responseBrief && `Prior response:\n${state.responseBrief}`,
  ].filter(Boolean).join("\n\n");
  return sections.slice(-limit);
}

export function saveTaskState(dir, id, model, messages, response) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const value = { version: 3, updatedAt: new Date().toISOString(), model, ...taskStateFromMessages(messages, response) };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(value)}\n`);
}

export function loadTaskState(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")); } catch { return null; }
}
