import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./solution.mjs";
test("clamp bounds a value", () => {
  assert.equal(clamp(-1, 0, 4), 0);
  assert.equal(clamp(7, 0, 4), 4);
  assert.equal(clamp(2, 0, 4), 2);
});
