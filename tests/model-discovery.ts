import assert from "node:assert/strict";
import { rankCandidates } from "../scripts/model-discovery.ts";
const result = rankCandidates([
  { id: "small", downloads: 10, likes: 2 },
  { id: "popular", downloads: 10000, likes: 3 },
]);
assert.equal(result[0].id, "popular");
assert.equal(result[0].score > result[1].score, true);
console.log("model discovery: ok");
