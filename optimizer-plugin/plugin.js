// @ts-check
"use strict";

const generateJS = require("../lib/compiler/passes/generate-js");
const mergeCharacterClasses = require("../lib/compiler/passes/merge-character-classes");
const { optimizeBytecode } = require("../lib/compiler/passes/optimize-bytecode");

function use(config) {
  if (!config.passes.transform.find(
    f => /^mergeCharacterClasses(\$|$)/.test(f.name)
  )) {
    config.passes.transform.push(mergeCharacterClasses);
  }
  if (!config.passes.generate.find(
    f => /^optimizeBytecode(\$|$)/.test(f.name)
  )) {
    if (/^generateJS(\$|$)/.test(
      config.passes.generate[
        config.passes.generate.length - 1
      ].name
    )) {
      config.passes.generate.splice(-1, 1, optimizeBytecode, generateJS);
    }
  }
}

module.exports = { use };
