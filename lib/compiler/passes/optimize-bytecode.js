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
 * @typedef {import("../interp-state").InterpType} InterpType
 */

/**
 * Determine whether a block is "cheap". We're considering duplicating this
 * block into the ends of several other blocks. POPing things from the stack is
 * generally cheap, and will typically not add anything to the final code (and
 * may even make it cheaper). PUSHing is also cheap, as long as the net effect
 * is to leave fewer things on the stack than we started with.
 *
 * @param {FormattedBytecode} bc
 */
function cheapBlock(bc) {
  let numPop = 0;
  let numPush = 0;
  for (let i = 0; i < bc.length; i++) {
    const cur = bc[i];
    switch (cur[0]) {
      case op.POP_N:
        numPop += cur[1];
        break;
      case op.POP:
      case op.NIP:
      case op.POP_CURR_POS:
        numPop++;
        break;
      case op.PLUCK:
        if (cur[2] !== 1) {
          return false;
        }
        numPop += cur[1] - 1;
        return true;
      case op.PUSH_NULL:
      case op.PUSH_UNDEFINED:
      case op.PUSH_FAILED:
        if (numPush++) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return numPop >= numPush;
}

/**
 *
 * @this {InterpState}
 * @param {FormattedBytecode} bc
 * @param {number} ip
 * @param {InterpResult} result
 * @returns {InterpResult}
 */
function postInterp(bc, ip, result) {
  const nextBc = bc[result.ip];
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
      if (nextBc && (nextBc[0] === op.POP || nextBc[0] === op.POP_N)) {
        const npops = nextBc[0] === op.POP_N ? nextBc[1] : 1;
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
  if (result.condState && nextBc) {
    switch (nextBc[0]) {
      case op.IF_ERROR:
      case op.IF_NOT_ERROR:
      case op.IF:
      case op.WHILE_NOT_ERROR: {
        const [thenCode, elseCode] = nextBc[0] === op.WHILE_NOT_ERROR
          ? [[nextBc], []]
          : InterpState.getConditionalCode(nextBc);

        /** @type {Array<(t:InterpType)=>boolean>} */
        const testFns = nextBc[0] === op.IF
          ? [
              type => InterpState.mustBeTrue(type),
              type => InterpState.mustBeFalse(type),
            ]
          : [
              type => !InterpState.couldBe(type, TypeTag.FAILED),
              type => InterpState.mustBe(type, TypeTag.FAILED),
            ];
        const [runThen, runElse] = nextBc[0] === op.IF_ERROR
          ? testFns.reverse()
          : testFns;
        const cheapThen = cheapBlock(thenCode);
        const cheapElse = cheapBlock(elseCode);

        let numNonCheapThen = 0;
        let numNonCheapElse = 0;
        let numUnknown = 0;
        let numThen = 0;
        let numElse = 0;
        if (InterpState.traverseCondState(
          bc[ip], result.condState, state => {
            const type = state.top();
            if (runThen(type)) {
              numThen++;
              if (!cheapThen) {
                numNonCheapThen++;
              }
              return true;
            }
            if (runElse(type)) {
              numElse++;
              if (!cheapElse) {
                numNonCheapElse++;
              }
              return true;
            }
            numThen++;
            numElse++;
            return !numUnknown++;
          }
        ) && (numUnknown
          ? !numNonCheapThen && !numNonCheapElse
          : numNonCheapThen <= 1 && numNonCheapElse <= 1)
        ) {
          let first = true;
          InterpState.traverseCondState(
            bc[ip], result.condState, (state, block) => {
              const type = state.top();
              if (runThen(type)) {
                const t = numThen > 1
                  ? InterpState.formatBytecode(InterpState.flattenBc(thenCode))
                  : thenCode;
                state.run(t);
                block.push(...t);
              } else if (runElse(type)) {
                const e = numElse > 1
                  ? InterpState.formatBytecode(InterpState.flattenBc(elseCode))
                  : elseCode;
                state.run(e);
                block.push(...e);
              } else {
                const b = [nextBc];
                state.run(b);
                block.push(...b);
              }
              if (first) {
                this.copy(state);
                first = false;
              } else {
                this.merge(state);
              }
              return true;
            }
          );
          result.bytecodeMods = {
            startOffset: result.ip,
            length: 1,
            replacements: [],
          };
          return result;
        }
        break;
      }
      default:
        break;
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
  const cur = bc[ip];
  switch (cur[0]) {
    case op.RULE:
    case op.ACCEPT_N:
    case op.ACCEPT_STRING:
    case op.FAIL:
    case op.PUSH_EMPTY_ARRAY:
    case op.PUSH_EMPTY_STRING:
    case op.PUSH_FAILED:
    case op.PUSH_NULL:
    case op.PUSH_CURR_POS:
    case op.PUSH_UNDEFINED: {
      const next = bc[ip + 1];
      if (next && next[0] === op.NIP) {
        this.discard(1);
        const result = this.interp(bc, ip);
        result.bytecodeMods = {
          startOffset: ip,
          length: 2,
          replacements: [[op.POP], cur],
        };
        result.ip++;
        return result;
      }
      break;
    }
    case op.CALL: {
      const next = bc[ip + 1];
      if (next && next[0] === op.NIP) {
        cur[2]++;
        const result = this.interp(bc, ip);
        bc.splice(ip + 1, 1);
        result.bytecodeMods = true;
        return result;
      }
      break;
    }
    case op.TEXT: {
      const next = bc[ip + 1];
      if (next && (next[0] === op.POP || next[0] === op.POP_N)) {
        bc.splice(ip, 1);
        const result = this.interp(bc, ip);
        result.bytecodeMods = true;
        return result;
      }
      if (next && next[0] === op.NIP) {
        this.interp(bc, ip);
        const result = this.interp(bc, ip + 1);
        bc.splice(ip, 2, next, cur);
        result.bytecodeMods = true;
        return result;
      }
      break;
    }

    case op.POP_CURR_POS: {
      const top = this.top();
      if (top.type === TypeTag.OFFSET
            && top.value
            && top.value === this.currPos.value) {
        this.pop();
        cur[0] = op.POP;
        return {
          ip: ip + 1,
          bytecodeMods: true,
        };
      }
      break;
    }
    case op.NIP: {
      const next = bc[ip + 1];
      if (!next) {
        break;
      }
      if (next[0] === op.POP || next[0] === op.POP_N) {
        this.pop();
        cur[0] = op.POP;
        return {
          ip: ip + 1,
          bytecodeMods: true,
        };
      }
      break;
    }
    case op.WRAP:
    case op.PLUCK: {
      const next = bc[ip + 1];
      if (!next) {
        break;
      }
      if (next[0] === op.POP || next[0] === op.POP_N) {
        const npop = cur[1];
        if (npop === 0) {
          cur.splice(0, cur.length, op.PUSH_NULL);
          this.push({ type:TypeTag.NULL });
        } else if (npop === 1) {
          bc.splice(ip, 1);
          return { ip, bytecodeMods: true };
        } else {
          this.discard(npop - 1);
          cur.splice(0, cur.length, op.POP_N, npop - 1);
        }
        return {
          ip: ip + 1,
          bytecodeMods: true,
        };
      }
      if (next[0] === op.NIP) {
        const n = cur[1];
        if (cur[0] === op.WRAP) {
          if (n === 1) {
            // A 1 element WRAP isn't the same as a 1 element PLUCK
            // because PLUCK returns a value, but WRAP returns an array.
            // but we can swap the WRAP and NIP.
            this.interp(bc, ip);
            const result = this.interp(bc, ip + 1);
            result.bytecodeMods = {
              startOffset: ip,
              length: 2,
              replacements: [[op.NIP], cur],
            };
            return result;
          }
          // Convert the WRAP to an equivalent PLUCK
          cur[0] = op.PLUCK;
          cur.push(n);
          for (let i = n; i--;) {
            cur.push(i);
          }
        }
        cur[1]++;
        const result = this.interp(bc, ip);
        bc.splice(ip + 1, 1);
        result.bytecodeMods = true;
        return result;
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
 * @param {PEG.ast.Grammar | null} ast - The Grammar we're working on
 * @param {number[]} bytecode          - The bytecode to optimize
 * @param {string}   name              - Name for error reporting purposes
 * @param {boolean}  [log]             - Whether to report changes to the bytecode
 * @returns {number[]}
 */
function optimizeBlock(ast, bytecode, name, log) {
  const dolog = log || logging;
  const fbc = InterpState.formatBytecode(bytecode);
  let changes = false;
  for (;;) {
    const state = new InterpState(name, ast);
    state.postInterp = postInterp;
    state.preInterp = preInterp;
    if (!state.run(fbc).changes) {
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
      rule.bytecode = optimizeBlock(ast, rule.bytecode, rule.name);
    }
  });
}

module.exports = {
  optimizeBytecode,
  optimizeBlock,
};
