import fs from "node:fs";
import path from "node:path";

export function createRuntimeState(directory) {
  const events = []; const perModel = new Map();
  const record = (type, value = {}) => { const event = { at: new Date().toISOString(), type, ...value }; events.push(event); if (events.length > 500) events.shift(); if (directory) { fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "runtime-events.jsonl"), `${JSON.stringify(event)}\n`); } return event; };
  return { record, events, begin(model) { const value = perModel.get(model) || { requests: 0, failures: 0, allocatedRamBytes: 0, allocatedVramBytes: 0 }; value.requests += 1; perModel.set(model, value); return value; }, fail(model, reason) { const value = perModel.get(model); if (value) value.failures += 1; record("recovery", { model, reason }); }, resource(model, ramBytes, vramBytes) { const value = perModel.get(model) || {}; value.allocatedRamBytes = ramBytes; value.allocatedVramBytes = vramBytes; perModel.set(model, value); }, snapshot() { return { events: events.slice(-100), models: Object.fromEntries(perModel) }; } };
}
