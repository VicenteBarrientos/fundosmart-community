"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const upstream = require("brace-expansion-safe");
const expand = typeof upstream === "function" ? upstream : upstream.expand;

if (typeof expand !== "function") {
  throw new TypeError("The patched brace-expansion package does not expose expand().");
}

module.exports = expand;
module.exports.expand = expand;
module.exports.escape = upstream.escape;
module.exports.unescape = upstream.unescape;
