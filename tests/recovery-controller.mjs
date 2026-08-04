import assert from "node:assert/strict";
import { classifyFailure, withRecovery } from "../scripts/recovery-controller.mjs";

assert.deepEqual(classifyFailure(new Error("CUDA out of memory")), { kind: "oom", retry: true });
assert.deepEqual(classifyFailure(Object.assign(new Error("cancelled"), { name: "AbortError" })), { kind: "cancelled", retry: false });
assert.deepEqual(classifyFailure(new Error("POST failed: 503")), { kind: "upstream", retry: true });
let attempts = 0; let recovered = false;
const value = await withRecovery(async () => { attempts += 1; if (attempts === 1) throw new Error("fetch failed"); return "ok"; }, async () => { recovered = true; });
assert.equal(value, "ok"); assert.equal(attempts, 2); assert.equal(recovered, true);
await assert.rejects(() => withRecovery(() => { throw new Error("invalid request"); }, () => { throw new Error("must not recover"); }));
console.log("recovery controller: ok");
