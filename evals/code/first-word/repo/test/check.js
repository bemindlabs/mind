import assert from "node:assert/strict";
import { firstWord } from "../src/words.js";

assert.equal(firstWord("Hello there"), "hello");
assert.equal(firstWord(""), "");
assert.equal(firstWord("   "), "");
