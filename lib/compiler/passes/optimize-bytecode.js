// @ts-check
"use strict";

const op = require("../opcodes");
const { InterpState, TypeTag } = require("../interp-state");

/** @type {boolean|string} */
const logging = false;

/**
 * @typedef {import("../../peg")} PEG
 * @typedef {import("../interp-state").InterpResult} InterpResult
 * @typedef {import("../interp-state").FormattedBytecode} FormattedBytecode
 */

/**
 *
 * @this {InterpState}
 * @param {FormattedBytecode} bc
 * @param {number} ip
 * @param {InterpResult} result
 * @returns {InterpResult}
 */
function postInterp(bc, ip, result) {
  switch (bc[ip][0]) {
    case op.FAIL:
      if (!this.silentFails) {
        break;
      }
    // Fallthrough
    case op.PUSH_EMPTY_ARRAY:
    case op.PUSH_EMPTY_STRING:
    case op.PUSH_FAILED:
    case op.PUSH_NULL:
    case op.PUSH_CURR_POS:
    case op.PUSH_UNDEFINED: {
      const next = bc[result.ip];
      if (next && (next[0] === op.POP || next[0] === op.POP_N)) {
        const npops = next[0] === op.POP_N ? next[1] : 1;
        /** @type {FormattedBytecode} */
        const replacements = [];
        if (npops > 1) {
          replacements.push(
            (npops > 2 ? [op.POP_N, npops - 1] : [op.POP])
          );
        }
        result.ip++;
        result.bytecodeMods = {
          startOffset: ip,
          length: result.ip - ip,
          replacements,
        };
        this.discard(npops);
      } else if (bc[ip][0] === op.FAIL) {
        result.bytecodeMods = true;
        bc[ip].splice(0, 2, op.PUSH_FAILED);
      } else if (next && next[0] === op.NIP) {
        result.ip++;
        result.bytecodeMods = {
          startOffset: ip,
          length: result.ip - ip,
          replacements: [[op.POP], bc[ip]],
        };
        const top = this.pop();
        this.discard(1);
        this.push(top);
      }
      return result;
    }
    case op.POP_CURR_POS: {
      if (InterpState.killsCurrPos(bc, result.ip)) {
        result.bytecodeMods = {
          startOffset: ip,
          length: result.ip - ip,
          replacements: [[op.POP]],
        };
      }
      return result;
    }
    case op.SILENT_FAILS_ON:
      if (this.silentFails > 1) {
        result.bytecodeMods = {
          startOffset: ip,
          length: 1,
          replacements: [],
        };
      }
      break;
    case op.SILENT_FAILS_OFF:
      if (this.silentFails) {
        result.bytecodeMods = {
          startOffset: ip,
          length: 1,
          replacements: [],
        };
      }
      break;

    default:
      break;
  }
  if (result.thenState
        && result.elseState
        && result.ip !== undefined
        && result.thenState.stack.length === result.elseState.stack.length
        && bc[result.ip]) {
    let swap = null;
    let whole = false;
    const nextBc = bc[result.ip];
    switch (nextBc[0]) {
      case op.IF_ERROR:
      case op.IF_NOT_ERROR: {
        const thenType = result.thenState.top();
        const elseType = result.elseState.top();
        if (InterpState.mustBe(elseType, TypeTag.FAILED)
              && !InterpState.couldBe(thenType, TypeTag.FAILED)) {
          swap = nextBc[0] === op.IF_ERROR;
        } else if (InterpState.mustBe(thenType, TypeTag.FAILED)
              && !InterpState.couldBe(elseType, TypeTag.FAILED)) {
          swap = nextBc[0] === op.IF_NOT_ERROR;
        } else if (nextBc[2].length === 0) {
          if (nextBc[0] === op.IF_NOT_ERROR) {
            if (InterpState.mustBe(elseType, TypeTag.FAILED)) {
              swap = false;
              whole = true;
            } else if (InterpState.mustBe(thenType, TypeTag.FAILED)) {
              swap = true;
              whole = true;
            }
          } else if (!InterpState.couldBe(elseType, TypeTag.FAILED)) {
            swap = false;
            whole = true;
          } else if (!InterpState.couldBe(thenType, TypeTag.FAILED)) {
            swap = true;
            whole = true;
          }
        }
        break;
      }
      case op.IF: {
        const thenType = result.thenState.top();
        const elseType = result.elseState.top();
        if (InterpState.mustBeFalse(elseType)) {
          if (InterpState.mustBeTrue(thenType)) {
            swap = false;
          } else if (nextBc[2].length === 0) {
            swap = false;
            whole = true;
          }
        } else if (InterpState.mustBeFalse(thenType)) {
          if (InterpState.mustBeTrue(elseType)) {
            swap = true;
          } else if (nextBc[2].length === 0) {
            swap = true;
            whole = true;
          }
        }
        break;
      }
      case op.WHILE_NOT_ERROR: {
        // If one branch of the if/else is guaranteed to result in
        // FAILED, we can pull the while into the other branch.
        const thenType = result.thenState.top();
        const elseType = result.elseState.top();
        if (InterpState.mustBe(elseType, TypeTag.FAILED)) {
          swap = false;
          whole = true;
        } else if (InterpState.mustBe(thenType, TypeTag.FAILED)) {
          swap = true;
          whole = true;
        }
        break;
      }
      default:
        return result;
    }
    if (swap !== null) {
      const [thenCode, elseCode] = whole
        ? [[nextBc], []]
        : InterpState.getConditionalCode(nextBc);
      const [prevThen, prevElse] = InterpState.getConditionalCode(bc[ip]);

      const bytecodeMods = {
        startOffset: result.ip,
        length: 1,
        replacements: [],
      };
      const [t, e] = swap ? [elseCode, thenCode] : [thenCode, elseCode];
      result.thenState.run(t);
      result.elseState.run(e);
      prevThen.push(...t);
      prevElse.push(...e);
      result.bytecodeMods = bytecodeMods;
      result.ip++;
      this.copy(result.thenState);
      this.merge(result.elseState);
    }
  }
  return result;
}

/**
 *
 * @this {InterpState}
 * @param {FormattedBytecode} bc
 * @param {number} ip
 * @returns {InterpResult | null}
 */
function preInterp(bc, ip) {
  switch (bc[ip][0]) {
    case op.POP_CURR_POS: {
      const top = this.top();
      if (top.type === TypeTag.OFFSET
            && top.value
            && top.value === this.currPos.value) {
        this.pop();
        return {
          ip: ip + 1,
          bytecodeMods: {
            startOffset: ip,
            length: 1,
            replacements: [[op.POP]],
          },
        };
      }
      break;
    }
    default:
      break;
  }
  return null;
}

/**
 *
 * @param {number[]} bytecode - The bytecode to optimize
 * @param {string}   name - Name for error reporting purposes
 * @param {boolean}  [log] - Whether to report changes to the bytecode
 * @returns {number[]}
 */
function optimizeBlock(bytecode, name, log) {
  const dolog = log || logging;
  const fbc = InterpState.formatBytecode(bytecode);
  let changes = false;
  for (;;) {
    const state = new InterpState(name);
    state.postInterp = postInterp;
    state.preInterp = preInterp;
    if (!state.run(fbc)) {
      break;
    }
    changes = true;
  }
  const bc = changes ? InterpState.flattenBc(fbc) : bytecode;
  if (changes && (dolog === true || dolog === name)) {
    console.log("Before >>>");
    console.log(InterpState.print(bytecode, name));
    console.log("After >>>");
    console.log(InterpState.print(bc, name));
  }
  return bc;
}

/**
 * Optimizes the bytecode.
 *
 * @param {PEG.ast.Grammar} ast
 * @param {PEG.SourceBuildOptions<PEG.SourceOutputs>} options
 */
function optimizeBytecode(ast, options) {
  if (options.output === "source-and-map"
      || options.output === "source-with-inline-map") {
    // The optimizations are not very effective with source maps
    // turned on, and any optimizations are likely to make the
    // source mapping worse.
    return;
  }

  ast.rules.forEach(rule => {
    if (rule.bytecode) {
      rule.bytecode = optimizeBlock(rule.bytecode, rule.name);
    }
  });
}

module.exports = {
  optimizeBytecode,
  optimizeBlock,
};
