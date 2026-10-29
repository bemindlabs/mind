import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  a  b -- c!! "), "a-b-c");
assert.equal(slugify("--x--"), "x");
