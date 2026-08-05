import fs from "node:fs";
import path from "node:path";

export function createRuntimeState(directory) {
  const events = [];
  const perModel = new Map();
  let activeModel = null;
  const record = (type, value = {}) => {
    const event = { at: new Date().toISOString(), type, ...value };
    events.push(event);
    if (events.length > 500) events.shift();
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(path.join(directory, "runtime-events.jsonl"), `${JSON.stringify(event)}\n`);
    }
    return event;
  };
  const valueFor = (model) =>
    perModel.get(model) || {
      requests: 0,
      completions: 0,
      failures: 0,
      allocatedRamBytes: null,
      allocatedVramBytes: null,
      observedRamBytes: null,
      observedVramBytes: null,
      averageLatencyMs: null,
      promptTps: null,
      decodeTps: null,
    };
  return {
    record,
    events,
    begin(model) {
      const value = valueFor(model);
      value.requests += 1;
      perModel.set(model, value);
      return value;
    },
    fail(model, reason) {
      const value = valueFor(model);
      value.failures += 1;
      perModel.set(model, value);
      record("recovery", { model, reason });
    },
    allocation(model, before, after) {
      const value = valueFor(model);
      // llama.cpp hosts one active worker, so measurements immediately after
      // unloading peers and loading this worker give a useful model delta.
      value.allocatedRamBytes = Math.max(
        0,
        Math.round(((before.freeRamGiB || 0) - (after.freeRamGiB || 0)) * 2 ** 30),
      );
      value.allocatedVramBytes = Math.max(
        0,
        Math.round(((after.gpu?.usedMiB || 0) - (before.gpu?.usedMiB || 0)) * 1048576),
      );
      value.allocationMeasuredAt = new Date().toISOString();
      activeModel = model;
      perModel.set(model, value);
      record("allocation", {
        model,
        ramBytes: value.allocatedRamBytes,
        vramBytes: value.allocatedVramBytes,
      });
    },
    resource(model, ramBytes, vramBytes) {
      const value = valueFor(model);
      value.observedRamBytes = ramBytes;
      value.observedVramBytes = vramBytes;
      perModel.set(model, value);
    },
    complete(model, { latencyMs, promptTps, decodeTps } = {}) {
      const value = valueFor(model);
      value.completions += 1;
      if (Number.isFinite(latencyMs))
        value.averageLatencyMs = Math.round(
          ((value.averageLatencyMs || 0) * (value.completions - 1) + latencyMs) / value.completions,
        );
      if (Number.isFinite(promptTps)) value.promptTps = promptTps;
      if (Number.isFinite(decodeTps)) value.decodeTps = decodeTps;
      perModel.set(model, value);
    },
    activate(model) {
      activeModel = model;
    },
    active() {
      return activeModel;
    },
    snapshot() {
      return { activeModel, events: events.slice(-100), models: Object.fromEntries(perModel) };
    },
  };
}
