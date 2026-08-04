import fs from "node:fs";
import path from "node:path";

export function createRuntimeState(directory) {
  const events = []; const perModel = new Map();
  const record = (type, value = {}) => { const event = { at: new Date().toISOString(), type, ...value }; events.push(event); if (events.length > 500) events.shift(); if (directory) { fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(path.join(directory, "runtime-events.jsonl"), `${JSON.stringify(event)}\n`); } return event; };
  const valueFor = (model) => perModel.get(model) || { requests: 0, failures: 0, allocatedRamBytes: null, allocatedVramBytes: null, observedRamBytes: null, observedVramBytes: null };
  return {
    record, events,
    begin(model) { const value = valueFor(model); value.requests += 1; perModel.set(model, value); return value; },
    fail(model, reason) { const value = valueFor(model); value.failures += 1; perModel.set(model, value); record("recovery", { model, reason }); },
    allocation(model, before, after) {
      const value = valueFor(model);
      // llama.cpp hosts one active worker, so measurements immediately after
      // unloading peers and loading this worker give a useful model delta.
      value.allocatedRamBytes = Math.max(0, Math.round(((before.freeRamGiB || 0) - (after.freeRamGiB || 0)) * 2 ** 30));
      value.allocatedVramBytes = Math.max(0, Math.round(((after.gpu?.usedMiB || 0) - (before.gpu?.usedMiB || 0)) * 1048576));
      value.allocationMeasuredAt = new Date().toISOString(); perModel.set(model, value);
      record("allocation", { model, ramBytes: value.allocatedRamBytes, vramBytes: value.allocatedVramBytes });
    },
    resource(model, ramBytes, vramBytes) { const value = valueFor(model); value.observedRamBytes = ramBytes; value.observedVramBytes = vramBytes; perModel.set(model, value); },
    snapshot() { return { events: events.slice(-100), models: Object.fromEntries(perModel) }; },
  };
}
