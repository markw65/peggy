// @ts-check
"use strict";

const op = require("./opcodes");

/**
 * @typedef {import("../peg")} PEG
 */

const TypeTag = /** @type {const} */ ({
  UNDEFINED: 0b0000001,
  NULL:      0b0000010,
  FAILED:    0b0000100,
  OFFSET:    0b0001000,
  ARRAY:     0b0010000,
  STRING:    0b0100000,
  ANY:       0b1111111,
});

/**
 * An array in which each element is an array representing a bytecode. For most
 * bytecodes, the array is just the array of codes for a single bytecode. But
 * for conditionals and loops, the sub-clauses are just recursive
 * FormattedBytecode arrays. This format has a couple of advantages. First,
 * there are no offsets to keep up to date. If you delete a bytecode from the
 * then clause of a MATCH_CHAR_CLASS thats in the else clause of a
 * IF_NOT_FAILED, its not necessary to update the MATCH_CHAR_CLASS or the
 * IF_NOT_FAILED (in "flat" bytecode, you'd have to update lengths in both of
 * them to make sure everything was properly aligned). Secondly, if you want to
 * keep track of a bytecode, to come back to it later, you can just keep a
 * reference to its array.
 * @typedef {FormattedElement[]} FormattedBytecode
 */

/**
  @typedef {typeof op[keyof typeof op]} AllOpcodes
  @typedef {
    |typeof op.IF
    |typeof op.IF_ERROR
    |typeof op.IF_NOT_ERROR
    |typeof op.MATCH_ANY
   } Cond0Opcodes
  @typedef {
    |typeof op.IF_GE
    |typeof op.IF_GE_DYNAMIC
    |typeof op.IF_LT
    |typeof op.IF_LT_DYNAMIC
    |typeof op.MATCH_STRING
    |typeof op.MATCH_STRING_IC
    |typeof op.MATCH_CHAR_CLASS
   } Cond1Opcodes
   @typedef {typeof op.WHILE_NOT_ERROR} LoopOpcodes
   @typedef {Exclude<AllOpcodes, Cond0Opcodes|Cond1Opcodes|LoopOpcodes>} FlatOpcodes
*/

/**
 * The elements of a FormattedBytecode. Each one represents a peggy bytecode,
 * except that conditionals and loops contain their sub-blocks.
 *
 * @typedef {FlatElement|Cond0Element|Cond1Element|LoopElement} FormattedElement
 */

/**
 * @typedef {[Cond0Opcodes, FormattedBytecode, FormattedBytecode]} Cond0Element
 * @typedef {[Cond1Opcodes, number, FormattedBytecode, FormattedBytecode]} Cond1Element
 * @typedef {[LoopOpcodes, FormattedBytecode]} LoopElement
 * @typedef {[FlatOpcodes, ...Array<number>]} FlatElement
 */

/**
 * A synthetic type, representing values in the interpreter.
 * @typedef {object}        InterpType
 * @property {number}       type
 * @property {string | {}}  [value]
 */

/**
 * A description of modifications to be made to the bytecode
 * @typedef {object}              BytecodeMods
 * @property {number}             startOffset
 * @property {number}             length
 * @property {FormattedBytecode}  replacements
 */

/**
 * The state at the end of a conditional bytecode, which may recursively include
 * more `CondState`s if a branch of the conditional finished with another
 * conditional.
 *
 * @typedef {object}                    CondState
 * @property {InterpState & {thenState?:undefined}|CondState}    thenState
 * @property {InterpState & {elseState?:undefined}|CondState}    elseState
 */

/**
 * Description of the effects of an interp step
 * @typedef {object}        InterpResult
 * @property {number}       ip - the next bytecode offset
 * @property {CondState}    [condState]
 *    - for conditionals, the then/else states before the join
 * @property {BytecodeMods | boolean} [bytecodeMods]
 *    - any modificationss requested by this step.
 */

/**
 * Description of the effects of a run step
 * @typedef {object}      RunResult
 * @property {boolean}    changes
 * @property {CondState}  [condState]
 */

/**
 * @callback PreInterp
 * @param {FormattedBytecode} bc
 * @param {number}           ip
 * @returns {InterpResult | null}
 */

/**
 * @callback PostInterp
 * @param {FormattedBytecode} bc
 * @param {number}           ip
 * @param {InterpResult}     result
 * @returns {InterpResult}
 */

/**
 * @callback PreRun
 * @param {FormattedBytecode} bc
 */

/**
 * @callback PostRun
 * @param {FormattedBytecode} bc
 */

/**
 * @callback InterpCondCallback
 * @param {InterpType}      top
 * @param {boolean}         forThen
 * @returns {[boolean, InterpType]}
 */

class InterpState {
  /**
   * Constructs a helper for tracking the state in the bytecode for the purposes
   * of optimizing it.
   *
   * @param {string}                 ruleName - The name of rule that will be used
   *                                            in error messages
   * @param {PEG.ast.Grammar | null} [ast]    - The Grammar being processed. Optional,
   *                                            but may, enable more optimizations.
   */
  constructor(ruleName, ast) {
    this.ast            = ast;
    this.ruleName       = ruleName;
    /** @type {PreInterp | null} */
    this.preInterp      = null;
    /** @type {PostInterp | null} */
    this.postInterp     = null;
    /** @type {PreRun | null} */
    this.preRun         = null;
    /** @type {PostRun | null} */
    this.postRun        = null;
    this.looping        = 0;

    /**
     * Symbolic stack.
     * @type {InterpType[]}
     */
    this.stack          = [];
    /** @type {InterpType} */
    this.currPos        = { type: TypeTag.OFFSET, value: {} };
    this.silentFails    = 0;
  }

  /**
   * Make this a copy of from
   *
   * @param {InterpState} from
   */
  copy(from) {
    this.stack = from.stack.slice();
    this.currPos = from.currPos;
    this.silentFails = from.silentFails;
    this.looping = from.looping;
    this.preInterp = from.preInterp;
    this.postInterp = from.postInterp;
    this.preRun = from.preRun;
    this.postRun = from.postRun;
  }

  /**
   * Clone this.
   *
   * @returns InterpState
   */
  clone() {
    const clone = new InterpState(this.ruleName, this.ast);
    clone.copy(this);
    return clone;
  }

  /**
   * Merge from into this (at a join point)
   *
   * @param {InterpState} from
   */
  merge(from) {
    if (this.stack.length !== from.stack.length) {
      throw new Error(
        `Rule '${this.ruleName}': Merging states with mis-matched stacks.`
      );
    }
    if (this.silentFails !== from.silentFails) {
      throw new Error(
        `Rule '${this.ruleName}': Merging states with mis-matched silentFails.`
      );
    }
    for (let i = this.stack.length; i--;) {
      this.stack[i] = InterpState.union(this.stack[i], from.stack[i]);
    }
    this.setCurrPos(InterpState.union(this.currPos, from.currPos));
  }

  /**
   *
   * @param {InterpState} from
   * @returns boolean
   */
  equal(from) {
    if (this.stack.length !== from.stack.length) {
      return false;
    }
    if (this.silentFails !== from.silentFails) {
      return false;
    }
    for (let i = this.stack.length; i--;) {
      if (!InterpState.equalType(this.stack[i], from.stack[i])) {
        return false;
      }
    }
    // Don't check currPos; its likely to change on each iteration of a loop,
    // but doesn't mean that the state didn't converge
    return true;
  }

  /**
   * Determine whether two InterpTypes are equal
   *
   * @param {InterpType} a
   * @param {InterpType} b
   * @returns {boolean}
   */
  static equalType(a, b) {
    if (a.type !== b.type) {
      return false;
    }
    return a.value === b.value;
  }

  /**
   * Compute the union of two InterpTypes
   *
   * @param {InterpType} a
   * @param {InterpType} b
   * @returns {InterpType}
   */
  static union(a, b) {
    const utype = a.type | b.type;
    if (a.value !== undefined
        && a.value === b.value
        && !(utype & (utype - 1))) {
      return { type: utype, value: a.value };
    }
    return { type: utype };
  }

  /**
   * Determine whether t could be one of types
   *
   * @param {InterpType} t
   * @param {number} types
   * @returns {boolean}
   */
  static couldBe(t, types) {
    return (t.type & types) !== 0;
  }

  /**
   * Determine whether t must be one of types
   *
   * @param {InterpType} t
   * @param {number} types
   * @returns {boolean}
   */
  static mustBe(t, types) {
    return (t.type & ~types) === 0 && t.type !== 0;
  }

  /**
   * Determine whether an InterpType must be truish
   *
   * @param {InterpType} t
   * @returns {boolean}
   */
  static mustBeTrue(t) {
    // ARRAY and FAILED always test true, anything else
    // could be false.
    return InterpState.mustBe(t, TypeTag.ARRAY | TypeTag.FAILED);
  }

  /**
   * Determine whether an InterpType must be falsish
   *
   * @param {InterpType} t
   * @returns {boolean}
   */
  static mustBeFalse(t) {
    // NULL and UNDEFINED always test false, anything else
    // could be true.
    return InterpState.mustBe(t, TypeTag.NULL | TypeTag.UNDEFINED);
  }

  /**
   * Given one of the "conditional" bytecodes, return the number
   * of arguments it consumes.
   *
   * @param {number} bc
   * @returns {number}
   */
  static getConditionalArgCount(bc) {
    switch (bc) {
      case op.IF:
      case op.IF_ERROR:
      case op.IF_NOT_ERROR:
      case op.MATCH_ANY:
        return 0;
      case op.IF_GE:
      case op.IF_GE_DYNAMIC:
      case op.IF_LT:
      case op.IF_LT_DYNAMIC:
      case op.MATCH_STRING:
      case op.MATCH_STRING_IC:
      case op.MATCH_CHAR_CLASS:
        return 1;
      default:
        throw new Error(`Expected a conditional bytecode, but got: ${bc}.`);
    }
  }

  /**
   *
   * @param {number} bc
   * @returns {asserts bc is Cond0Opcodes | Cond1Opcodes}
   */
  static assertConditionalOpcode(bc) {
    this.getConditionalArgCount(bc);
  }

  /**
   * Given a reference to a conditional bytecode, return the
   * then and else bytecodes as a tuple.
   *
   * @param {FormattedElement} bc
   * @returns {[FormattedBytecode, FormattedBytecode]}
   */
  static getConditionalCode(bc) {
    const thenCode = /** @type {FormattedBytecode} */ (bc[bc.length - 2]);
    const elseCode = /** @type {FormattedBytecode} */ (bc[bc.length - 1]);
    return [thenCode, elseCode];
  }

  /**
   *
   * @param {number[] | FormattedBytecode} bc
   * @param {number} ip
   * @returns {boolean}
   */
  static killsCurrPos(bc, ip) {
    /** @param {number} opc */
    function kills(opc) {
      switch (opc) {
        case op.POP_CURR_POS:
          return true;
        case op.POP:
        case op.PUSH_NULL:
        case op.PUSH_FAILED:
        case op.PUSH_UNDEFINED:
        case op.PUSH_EMPTY_STRING:
        case op.PUSH_EMPTY_ARRAY:
        case op.SILENT_FAILS_ON:
        case op.SILENT_FAILS_OFF:
          return 1;
        case op.FAIL:
        case op.POP_N:
          return 2;
        default:
          return false;
      }
    }
    if (!Array.isArray(bc[0])) {
      const nbc = /** @type {number[]} */(bc);
      for (;;) {
        const k = kills(nbc[ip]);
        if (k === false || k === true) {
          return k;
        }
        ip += k;
      }
    } else {
      const fbc = /** @type {FormattedBytecode} */(bc);
      for (;;) {
        if (ip === fbc.length) {
          return false;
        }
        const k = kills(fbc[ip][0]);
        if (k === false || k === true) {
          return k;
        }
        ip++;
      }
    }
  }

  /**
   * @param {FormattedElement} bc
   * @param {CondState} condState
   * @param {(state:InterpState, bc:FormattedBytecode) => unknown} visitor
   */
  static traverseCondState(bc, condState, visitor) {
    this.assertConditionalOpcode(bc[0]);
    const [thenBranch, elseBranch] = this.getConditionalCode(bc);
    if (condState.thenState.thenState) {
      if (this.traverseCondState(
        thenBranch[thenBranch.length - 1], condState.thenState, visitor
      ) === false) {
        return false;
      }
    } else {
      if (visitor(condState.thenState, thenBranch) === false) {
        return false;
      }
    }
    if (condState.elseState.elseState) {
      if (this.traverseCondState(
        elseBranch[elseBranch.length - 1], condState.elseState, visitor
      ) === false) {
        return false;
      }
    } else {
      if (visitor(condState.elseState, elseBranch) === false) {
        return false;
      }
    }
    return true;
  }

  /** @param {InterpType} value */
  push(value) {
    this.stack.push(value);
  }

  /** @returns {InterpType} */
  pop() {
    const value = this.stack.pop();
    if (!value) {
      throw new RangeError(
        `Rule '${this.ruleName}': Trying to pop from an empty stack.`
      );
    }
    return value;
  }

  /** @returns {InterpType} */
  top() {
    const value = this.stack.slice(-1).pop();
    if (!value) {
      throw new RangeError(
        `Rule '${this.ruleName}': Trying to access the top of an empty stack.`
      );
    }
    return value;
  }

  /**
   *
   * @param {number} depth
   * @returns {InterpType}
   */
  inspect(depth) {
    const value = this.stack[this.stack.length - 1 - depth];
    if (!value) {
      throw new RangeError(
        `Rule '${this.ruleName}': Trying to inspect element ${
          depth
        } in a stack of size ${this.stack.length}.`
      );
    }
    return value;
  }

  /**
   * Remove n elements from the stack, that are expected to be thrown away.
   *
   * @param {number} n
   * @returns {InterpType[]}
   */
  discard(n) {
    if (this.stack.length < n) {
      throw new RangeError(
        `Rule '${this.ruleName}': Trying to pop ${n} elements, but only ${this.stack.length} available.`
      );
    }
    if (n < 0) {
      throw new RangeError(
        `Rule '${this.ruleName}': Trying to discard ${n} elements.`
      );
    }
    return n ? this.stack.splice(-n) : [];
  }

  /**
   * Remove n elements from the stack, but (todo) mark them used.
   *
   * @param {number} n
   * @returns {InterpType[]}
   */
  popn(n) {
    return this.discard(n);
  }

  /**
   * Assign value to currPos.
   *
   * @param {InterpType} value
   */
  setCurrPos(value) {
    if (value.type !== TypeTag.OFFSET) {
      throw new Error(
        `Rule '${this.ruleName}': Invalid value assigned to currPos.`
      );
    }
    if (!value.value) {
      value = { type: TypeTag.OFFSET, value: {} };
    }
    this.currPos = value;
  }

  /**
   * Interpret one bytecode. This may result in a callback to
   * |run| for the then and else clauses of a conditional, or
   * the body of a loop.
   *
   * @param {FormattedBytecode} bcs
   * @param {number}            ip
   * @returns {InterpResult}
   */
  interp(bcs, ip) {
    const bc = bcs[ip];
    switch (bc[0]) {
      case op.PUSH_EMPTY_STRING:  // PUSH_EMPTY_STRING
        this.push({ type: TypeTag.STRING });
        break;

      case op.PUSH_CURR_POS:      // PUSH_CURR_POS
        this.push(this.currPos);
        break;

      case op.PUSH_UNDEFINED:     // PUSH_UNDEFINED
        this.push({ type: TypeTag.UNDEFINED });
        break;

      case op.PUSH_NULL:          // PUSH_NULL
        this.push({ type: TypeTag.NULL });
        break;

      case op.PUSH_FAILED:        // PUSH_FAILED
        this.push({ type: TypeTag.FAILED });
        break;

      case op.PUSH_EMPTY_ARRAY:   // PUSH_EMPTY_ARRAY
        this.push({ type: TypeTag.ARRAY, value: [] });
        break;

      case op.POP:                // POP
        this.discard(1);
        break;

      case op.POP_CURR_POS:       // POP_CURR_POS
        this.setCurrPos(this.pop());
        break;

      case op.POP_N:              // POP_N n
        this.popn(bc[1]);
        break;

      case op.NIP: {              // NIP
        const value = this.pop();
        this.discard(1);
        this.push(value);
        break;
      }

      case op.APPEND: {           // APPEND
        this.pop();
        const top = this.top();
        if (top.type !== TypeTag.ARRAY) {
          throw new Error(
            `Rule '${this.ruleName}': Attempting to append to a non-array.`
          );
        }
        break;
      }

      case op.WRAP:                // WRAP n
        this.push({
          type: TypeTag.ARRAY,
          value: this.popn(bc[1]),
        });
        break;

      case op.TEXT: {             // TEXT
        const offset = this.pop();
        if (offset.type !== TypeTag.OFFSET) {
          throw new Error(
            `Rule '${this.ruleName}': TEXT bytecode got an incorrect type: ${offset.type}.`
          );
        }
        this.push({ type: TypeTag.STRING });
        break;
      }

      case op.PLUCK: {            // PLUCK n, k, p1, ..., pK
        const baseLength = 3;
        const paramsLength = bc[baseLength - 1];
        const result = paramsLength === 1
          ? this.inspect(bc[baseLength])
          : {
              type: TypeTag.ARRAY,
              value: bc.slice(baseLength).map(
                p => this.inspect(p)
              ),
            };

        this.popn(bc[1]);
        this.push(result);
        break;
      }

      case op.IF:                 // IF t, f
        return this.interpCondition(bcs, ip, (top, forThen) => {
          if (forThen) {
            const type = {
              type: top.type & ~(TypeTag.UNDEFINED | TypeTag.NULL),
            };
            return [InterpState.mustBeTrue(top), type];
          } else {
            const type = { type: top.type & ~(TypeTag.FAILED | TypeTag.ARRAY) };
            return [InterpState.mustBeFalse(top), type];
          }
        });

      case op.IF_ERROR:           // IF_ERROR t, f
        return this.interpCondition(bcs, ip, (top, forThen) => {
          if (forThen) {
            return [top.type === TypeTag.FAILED, { type: TypeTag.FAILED }];
          } else {
            const type = { type: top.type & ~TypeTag.FAILED };
            return [!InterpState.couldBe(top, TypeTag.FAILED), type];
          }
        });

      case op.IF_NOT_ERROR:       // IF_NOT_ERROR t, f
        return this.interpCondition(bcs, ip, (top, forThen) => {
          if (!forThen) {
            return [top.type === TypeTag.FAILED, { type: TypeTag.FAILED }];
          } else {
            const type = { type: top.type & ~TypeTag.FAILED };
            return [!InterpState.couldBe(top, TypeTag.FAILED), type];
          }
        });

      case op.IF_LT:              // IF_LT min, t, f
        return this.interpCondition(bcs, ip, null);

      case op.IF_GE:              // IF_GE max, t, f
        return this.interpCondition(bcs, ip, null);

      case op.IF_LT_DYNAMIC:      // IF_LT_DYNAMIC min, t, f
        return this.interpCondition(bcs, ip, null);

      case op.IF_GE_DYNAMIC:      // IF_GE_DYNAMIC max, t, f
        return this.interpCondition(bcs, ip, null);

      case op.WHILE_NOT_ERROR:    // WHILE_NOT_ERROR b
        return this.interpLoop(bc, ip);

      case op.MATCH_ANY:          // MATCH_ANY a, f, ...
        return this.interpCondition(bcs, ip, null);

      case op.MATCH_STRING:       // MATCH_STRING s, a, f, ...
        return this.interpCondition(bcs, ip, null);

      case op.MATCH_STRING_IC:    // MATCH_STRING_IC s, a, f, ...
        return this.interpCondition(bcs, ip, null);

      case op.MATCH_CHAR_CLASS:   // MATCH_CHAR_CLASS c, a, f, ...
        return this.interpCondition(bcs, ip, null);

      case op.ACCEPT_N:           // ACCEPT_N n
        this.push({ type: TypeTag.STRING });
        this.currPos = { type: TypeTag.OFFSET, value: {} };
        break;

      case op.ACCEPT_STRING:      // ACCEPT_STRING s
        this.push({ type: TypeTag.STRING });
        this.currPos = { type: TypeTag.OFFSET, value: {} };
        break;

      case op.FAIL:               // FAIL e
        this.push({ type: TypeTag.FAILED });
        break;

      case op.LOAD_SAVED_POS:     // LOAD_SAVED_POS p
        this.inspect(bc[1]);
        break;

      case op.UPDATE_SAVED_POS:   // UPDATE_SAVED_POS
        break;

      case op.CALL: {             // CALL f, n, pc, p1, p2, ..., pN
        bc.slice(4).map(
          p => this.inspect(p)
        );
        this.discard(bc[2]);
        this.push({ type:TypeTag.ANY });
        this.currPos = { type: TypeTag.OFFSET, value: {} };
        break;
      }

      case op.RULE: {             // RULE r
        const match = (this.ast && this.ast.rules[bc[1]].match) || 0;
        if (match > 0) {
          this.push({ type: TypeTag.ANY & ~TypeTag.FAILED });
        } else if (match < 0) {
          this.push({ type: TypeTag.FAILED });
        } else {
          this.push({ type: TypeTag.ANY });
        }
        this.currPos = { type: TypeTag.OFFSET, value: {} };
        break;
      }

      case op.SILENT_FAILS_ON:    // SILENT_FAILS_ON
        this.silentFails++;
        break;

      case op.SILENT_FAILS_OFF:   // SILENT_FAILS_OFF
        this.silentFails--;
        break;

      case op.SOURCE_MAP_PUSH:
        break;

      case op.SOURCE_MAP_POP:
        break;

      case op.SOURCE_MAP_LABEL_PUSH:
        break;

      case op.SOURCE_MAP_LABEL_POP:
        break;

      // istanbul ignore next Because we never generate invalid bytecode we cannot reach this branch
      default:
        throw new Error(`${this.ruleName}: Invalid opcode: ${bc[ip]}.`);
    }
    return { ip: ip + 1 };
  }

  /**
   * Interpret a conditional expression.
   *
   * The check callback should be passed if the condition depends
   * on the value on the top of the stack. It is called once for
   * the then clause (with forThen === true), and once for the else
   * clause (with forThen === false). It returns a tuple indicating
   * whether the specified clause can be statically determined to
   * execute, and what we know about the type of the top element on
   * the stack if it does execute (eg in the then clause of an IF_FAILED
   * we know that the top of stack is the "failed" token).
   *
   * @param {FormattedBytecode} bc
   * @param {number}                    ip
   * @param {InterpCondCallback | null} check
   *
   * @returns {InterpResult}
   */
  interpCondition(bc, ip, check) {
    const cbc = bc[ip];
    const thenSlice = /** @type {FormattedBytecode} */ (cbc[cbc.length - 2]);
    const elseSlice = /** @type {FormattedBytecode} */ (cbc[cbc.length - 1]);

    const thenState = this.clone();
    const [thenOnly, thenType] = check
      ? check(thenState.top(), true)
      : [false, null];
    const [elseOnly, elseType] = check
      ? check(this.top(), false)
      : [false, null];
    if (thenOnly || elseOnly) {
      if (thenOnly && elseOnly) {
        throw new Error(
          `Rule '${
            this.ruleName
          }': Conditional cannot be both always true and always false.`
        );
      }
      const slice = thenOnly ? thenSlice : elseSlice;
      this.run(slice);
      return {
        ip: ip + 1,
        bytecodeMods: {
          startOffset: ip,
          length: 1,
          replacements: slice,
        },
      };
    }
    if (thenType) {
      thenState.pop();
      thenState.push(thenType);
    }
    if (elseType) {
      this.pop();
      this.push(elseType);
    }
    const thenResult = thenState.run(thenSlice);
    const elseResult = this.run(elseSlice);
    const elseState = this.clone();
    if (!elseSlice.length) {
      if (thenState.stack.length > this.stack.length) {
        thenState.stack.splice(this.stack.length);
      }
    }
    ip += 1;
    this.merge(thenState);
    return {
      ip,
      condState: {
        thenState: thenResult.condState || thenState,
        elseState: elseResult.condState || elseState,
      },
      bytecodeMods: thenResult.changes || elseResult.changes,
    };
  }

  /**
   *
   * @param {LoopElement} bc
   * @param {number} ip
   * @returns {InterpResult}
   */
  interpLoop(bc, ip) {
    if (InterpState.mustBe(this.top(), TypeTag.FAILED)) {
      return {
        ip: ip + 1,
        bytecodeMods: {
          startOffset: ip,
          length: 1,
          replacements: [],
        },
      };
    }

    this.looping++;
    const state = this.clone();
    const slice = bc[1];
    for (;;) {
      this.run(slice);
      this.merge(state);
      if (this.equal(state)) {
        break;
      }
      state.copy(this);
    }
    this.looping--;
    return { ip: ip + 1, bytecodeMods: this.run(slice).changes === true };
  }

  /**
   *
   * @param {FormattedBytecode}  bc
   * @returns {RunResult}
   */
  run(bc) {
    let ip = 0;
    let changes = false;
    if (!this.looping && this.preRun) {
      this.preRun(bc);
    }
    /** @param {InterpResult} result */
    const applyMods = result => {
      if (result.bytecodeMods && !this.looping) {
        changes = true;
        if (result.bytecodeMods !== true) {
          bc.splice(
            result.bytecodeMods.startOffset,
            result.bytecodeMods.length,
            ...result.bytecodeMods.replacements
          );
          if (result.ip >= result.bytecodeMods.startOffset
            + result.bytecodeMods.length) {
            result.ip += result.bytecodeMods.replacements.length
            - result.bytecodeMods.length;
          }
        }
        delete result.bytecodeMods;
      }
    };
    let result = null;
    while (ip < bc.length) {
      result = this.preInterp && !this.looping && this.preInterp(bc, ip);
      if (!result) {
        result = this.interp(bc, ip);
        if (!this.looping && this.postInterp) {
          applyMods(result);
          result = this.postInterp(bc, ip, result);
        }
      }
      applyMods(result);
      ip = result.ip;
    }
    if (!this.looping && this.postRun) {
      this.postRun(bc);
    }
    if (result && result.condState) {
      return { changes, condState: result.condState };
    }
    return { changes };
  }

  /**
   *
   * @param {number[]} bc
   * @param {string} name
   */
  static print(bc, name) {
    let indent = -2;
    /** @type {string[]} */
    const parts = [];
    const map = Object.create(null);
    Object.entries(op).forEach(([key, value]) => {
      if (!/^(PUSH|MATCH_REGEXP)$/.test(key)) {
        map[value] = key;
      }
    });
    const state = new InterpState(name);
    state.preRun = function() {
      indent += 2;
    };
    state.postRun = function() {
      if (indent > 0) {
        parts.push(`${" ".repeat(indent)} --`);
      }
      indent -= 2;
    };
    state.preInterp = function(bc, ip) {
      const name = map[bc[ip][0]];
      const args = bc[ip].slice(1).filter(b => !Array.isArray(b));
      const i = parts.push(`${" ".repeat(indent)} ${name} ${
        args.length ? `(${args.join(" ")}) ` : ""
      }stack: ${this.stack.length}`);
      const result = this.interp(bc, ip);
      if (i === parts.length) {
        parts[i - 1] += ` => ${this.stack.length}`;
      }
      delete result.bytecodeMods;
      return result;
    };
    state.run(InterpState.formatBytecode(bc));
    return parts.join("\n");
  }

  /**
   *
   * @param {number[]} bc
   * @returns {FormattedBytecode}
   */
  static formatBytecode(bc) {
    /** @type {FormattedBytecode} */
    const result = [];
    let ip = 0;
    /**
     * @param {FlatOpcodes} cur
     * @param {number} n
     */
    function push(cur, n) {
      result.push([cur, ...bc.slice(ip + 1, ip + n)]);
      ip += n;
    }
    /**
     * @param {number} argCount
     * @returns {[FormattedBytecode, FormattedBytecode]}
     */
    function getConditional(argCount) {
      const baseLength = argCount + 3;
      const thenLength = bc[ip + baseLength - 2];
      const elseLength = bc[ip + baseLength - 1];
      const elseStart = ip + baseLength + thenLength;
      const elseEnd = elseStart + elseLength;
      const thenClause = InterpState.formatBytecode(
        bc.slice(ip + baseLength, elseStart)
      );
      const elseClause = InterpState.formatBytecode(
        bc.slice(elseStart, elseEnd)
      );
      ip = elseEnd;
      return [thenClause, elseClause];
    }
    while (ip < bc.length) {
      const cur = bc[ip];
      switch (cur) {
        case op.PUSH_EMPTY_STRING:  // PUSH_EMPTY_STRING
        case op.PUSH_CURR_POS:      // PUSH_CURR_POS
        case op.PUSH_UNDEFINED:     // PUSH_UNDEFINED
        case op.PUSH_NULL:          // PUSH_NULL
        case op.PUSH_FAILED:        // PUSH_FAILED
        case op.PUSH_EMPTY_ARRAY:   // PUSH_EMPTY_ARRAY
        case op.POP:                // POP
        case op.POP_CURR_POS:       // POP_CURR_POS
        case op.NIP:                // NIP
        case op.APPEND:             // APPEND
        case op.TEXT:               // TEXT
        case op.SILENT_FAILS_ON:    // SILENT_FAILS_ON
        case op.SILENT_FAILS_OFF:   // SILENT_FAILS_OFF
        case op.UPDATE_SAVED_POS:   // UPDATE_SAVED_POS
        case op.SOURCE_MAP_POP:
          push(cur, 1);
          break;

        case op.POP_N:              // POP_N n
        case op.WRAP:               // WRAP n
        case op.ACCEPT_N:           // ACCEPT_N n
        case op.ACCEPT_STRING:      // ACCEPT_STRING s
        case op.FAIL:               // FAIL e
        case op.LOAD_SAVED_POS:     // LOAD_SAVED_POS p
        case op.RULE:               // RULE r
        case op.SOURCE_MAP_PUSH:
        case op.SOURCE_MAP_LABEL_POP:
          push(cur, 2);
          break;

        case op.SOURCE_MAP_LABEL_PUSH:
          push(cur, 4);
          break;

        case op.PLUCK: {            // PLUCK n, k, p1, ..., pK
          const baseLength = 3;
          const paramsLength = bc[ip + baseLength - 1];
          push(cur, baseLength + paramsLength);
          break;
        }

        case op.IF:                 // IF t, f
        case op.IF_ERROR:           // IF_ERROR t, f
        case op.IF_NOT_ERROR:       // IF_NOT_ERROR t, f
        case op.MATCH_ANY:          // MATCH_ANY a, f, ...
          result.push([cur, ...getConditional(0)]);
          break;
        case op.IF_LT:              // IF_LT min, t, f
        case op.IF_GE:              // IF_GE max, t, f
        case op.IF_LT_DYNAMIC:      // IF_LT_DYNAMIC min, t, f
        case op.IF_GE_DYNAMIC:      // IF_GE_DYNAMIC max, t, f
        case op.MATCH_STRING:       // MATCH_STRING s, a, f, ...
        case op.MATCH_STRING_IC:    // MATCH_STRING_IC s, a, f, ...
        case op.MATCH_CHAR_CLASS: { // MATCH_CHAR_CLASS c, a, f, ...
          const arg = bc[ip + 1];
          result.push(
            [cur, arg, ...getConditional(1)]
          );
          break;
        }

        case op.WHILE_NOT_ERROR: {  // WHILE_NOT_ERROR b
          const end = ip + bc[ip + 1] + 2;
          const body = InterpState.formatBytecode(
            bc.slice(ip + 2, end)
          );
          result.push([cur, body]);
          ip = end;
          break;
        }

        case op.CALL:                // CALL f, n, pc, p1, p2, ..., pN
          push(cur, 4 + bc[ip + 3]);
          break;

        // istanbul ignore next Because we never generate invalid bytecode we cannot reach this branch
        default:
          throw new Error(`Invalid opcode: ${cur}.`);
      }
    }
    return result;
  }

  /**
   * @param {FormattedBytecode} fbc
   * @returns {number[]}
   */
  static flattenBc(fbc) {
    /** @type {number[]} */
    const result = [];
    fbc.forEach(e => {
      for (let i = 0; i < e.length; i++) {
        const x = e[i];
        if (Array.isArray(x)) {
          const bodies = e.slice(i).map(b => {
            if (!Array.isArray(b)) {
              throw new Error(
                "Incorrect formatted bytecode. Expected an Array"
              );
            }
            return InterpState.flattenBc(b);
          });
          if (bodies.length === 1) {
            if (e[0] !== op.WHILE_NOT_ERROR) {
              throw new Error(
                `Incorrect formatted bytecode. Expected '${
                  op.WHILE_NOT_ERROR
                }', but got ${e[0]}`
              );
            }
          } else {
            const args = InterpState.getConditionalArgCount(e[0]);
            if (i !== args + 1) {
              throw new Error(
                `Incorrect formatted bytecode. Expected ${
                  args
                } arguments for ${e[0]}, but got ${i - 1}`
              );
            }
            if (bodies.length !== 2) {
              throw new Error(
                `Incorrect formatted bytecode. Expected 2 bodies for ${
                  e[0]
                }, but got ${bodies.length}`
              );
            }
          }
          bodies.forEach(b => result.push(b.length));
          bodies.forEach(b => result.push(...b));
          break;
        }
        result.push(x);
      }
    });
    return result;
  }
}

module.exports = {
  TypeTag,
  InterpState,
};
