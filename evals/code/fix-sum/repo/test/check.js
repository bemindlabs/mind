import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

assert.equal(sum([1, 2, 3]), 6);
assert.equal(sum([5]), 5);
assert.equal(sum([]), 0);
