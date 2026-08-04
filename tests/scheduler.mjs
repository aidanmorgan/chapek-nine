import assert from "node:assert/strict";
import { createScheduler } from "../scripts/scheduler.mjs";

let now = 0;
const scheduler = createScheduler({ maxDepth: 3, agingMs: 10, now: () => now });
const order = [];
let release;
const gate = new Promise((resolve) => { release = resolve; });
const first = scheduler.submit(async () => { order.push("running"); await gate; });
const low = scheduler.submit(() => order.push("aged-low"), 0);
now = 20;
const normal = scheduler.submit(() => order.push("normal"), 1);
assert.equal(scheduler.snapshot().pending, 2);
assert.equal(scheduler.snapshot().oldestWaitMs, 20);
release();
await Promise.all([first, low, normal]);
assert.deepEqual(order, ["running", "aged-low", "normal"]);
assert.equal(scheduler.snapshot().completed, 3);
console.log("scheduler: ok");
