const assert = require("node:assert");
const lib = require("./sum.js");

assert.strictEqual(lib.sum([1, 2, 3]), 6);
assert.strictEqual(lib.sum([]), 0);
assert.strictEqual(lib.sum([-4, 4, 10]), 10);

assert.strictEqual(typeof lib.mean, "function", "mean() is not exported");
assert.strictEqual(lib.mean([2, 4, 6]), 4);
assert.ok(Number.isNaN(lib.mean([])), "mean([]) should be NaN");

console.log("all tests passed");
