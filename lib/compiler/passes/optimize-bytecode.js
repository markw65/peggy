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
 * @typedef {import("../interp-state").FormattedElement} FormattedElement
 * @typedef {import("../interp-state").InterpType} InterpType
 * @typedef {import("../interp-state").SlotCallback} SlotCallback
 */

/**
 *
 * @param {string} name
 * @param {FormattedBytecode} bcs
 */
function deadSlotRemoval(name, bcs) {
  let absIp = 0;
  let silentFails = 0;
  /** @type {FormattedElement[][]} */
  const silentGroups = [];
  /** @type {FormattedElement[]|null} */
  let curSilentGroup = null;
  /** @type {FormattedBytecode|null} */
  let curSilentBlock = null;

  /**
   * @typedef {object}              TrackedInst
   * @property {FormattedBytecode}  container
   * @property {number}             ip
   * @property {number}             absIp
   *
   * @typedef {object}              TrackedSlot
   * @property {TrackedInst[]}      instructions
   * @property {number}             slot
   */

  /**
   * @param {(TrackedSlot|null)[]} s1
   * @param {TrackedInst|null}     endInst1
   * @param {(TrackedSlot|null)[]} s2
   * @param {TrackedInst|null}     endInst2
   * @param {number}               start
   */
  function merge(s1, endInst1, s2, endInst2, start) {
    if (s1.length !== s2.length) {
      throw new Error(`${name}: Stack mismatch`);
    }
    for (let i = 0; i < s1.length; i++) {
      const s1i = s1[i];
      const s2i = s2[i];
      if (s1i === s2i) {
        continue;
      }
      if (!s1i) {
        if (endInst1 && s2i && i === s1.length - 1
          && s2i.instructions.every(inst => inst.absIp >= start)
        ) {
          s2i.instructions.push({ ...endInst1 });
          s1[i] = s2i;
        }
        continue;
      }
      if (!s2i) {
        if (endInst2 && i === s1.length - 1
          && s1i.instructions.every(inst => inst.absIp >= start)
        ) {
          s1i.instructions.push({ ...endInst2 });
        } else {
          s1[i] = null;
        }
        continue;
      }
      // istanbul ignore next By construction
      if (s1i.slot !== s2i.slot || s2i.slot !== i) {
        throw new Error(`${name}: Slot mismatch`);
      }
      s2i.instructions.forEach(inst => {
        // Slots that are as-yet-unused out of the two blocks must either have
        // been as-yet-unused-in (in which case, they're the same element, which
        // would have been handled by s1i === s2i above), or they were pushed
        // in the blocks themselves, in which case they can't have been pushed
        // by the same bytecode, or even in the same block.
        s1i.instructions.forEach(i2 => {
          // istanbul ignore next The whole forEach is just a consistency check
          if (inst.absIp === i2.absIp) {
            throw new Error(
              `${
                name
              }: Instructions for the same object were pushed by multiple blocks`
            );
          }
          // istanbul ignore next The whole forEach is just a consistency check
          if (i2.container === inst.container) {
            throw new Error(
              `${
                name
              }: A single container can't have multiple dead-out instructions for the same slot`
            );
          }
        });
        s1i.instructions.push(inst);
      });
    }
  }
  /**
   * @param {FormattedBytecode} bcs
   * @param {(TrackedSlot|null)[]} trackedState
   */
  function trackBlock(bcs, trackedState) {
    let ip = 0;
    /** @type {TrackedSlot[]} */
    const foundSlots = [];

    /** @type {SlotCallback} */
    function push(n) {
      while (n--) {
        trackedState.push({
          instructions: [{ container: bcs, ip, absIp }],
          slot: trackedState.length,
        });
      }
    }

    /** @type {SlotCallback} */
    function pop(n) {
      if (n > trackedState.length) {
        throw new Error(`${name}: Too many pops`);
      }
      while (n--) {
        const slot = trackedState.pop();
        if (!slot) {
          continue;
        }
        if (slot.instructions[0].container === bcs) {
          // The push and pop are in the same block.
          // istanbul ignore next If a slot was pushed in two or more places, it must have been
          // in different branches of an if/else; ie, different blocks
          if (slot.instructions.length !== 1) {
            throw new Error(
              `${name}: A push pop pair in a single block should have a single start and end point`
            );
          }
          if (slot.instructions[0].ip + 1 === ip
            && (bcs[ip][0] === op.POP || bcs[ip][0] === op.POP_N)) {
            // No point tracking something like `ACCEPT_N; POP`
            continue;
          }
        } else {
          // istanbul ignore next As above
          if (!slot.instructions.every(i => i.container !== bcs)) {
            throw new Error(
              `${name}: A push pop pair in a single block should have a single start and end point`
            );
          }
        }
        foundSlots.push(slot);
      }
    }

    /** @type {SlotCallback} */
    function inspect(depth) {
      if (depth >= trackedState.length) {
        throw new Error(`${name}: Looking at a stack slot below the bottom of the stack`);
      }

      trackedState[trackedState.length - depth - 1] = null;
    }

    /**
     *
     * @param {TrackedSlot[]} slots
     * @param {number} localStart
     */
    function handleSlots(slots, localStart) {
      return slots.filter(slot => {
        if (slot.instructions.every(i => i.absIp >= localStart)) {
          foundSlots.push(slot);
          return false;
        }
        return true;
      });
    }
    while (ip < bcs.length) {
      const bc = bcs[ip];
      switch (bc[0]) {
        case op.SILENT_FAILS_ON:
          if (!silentFails++) {
            curSilentGroup = [];
            curSilentBlock = bcs;
          }
          if (curSilentGroup) {
            curSilentGroup.push(bc);
          }
          break;
        case op.SILENT_FAILS_OFF:
          --silentFails;
          if (curSilentGroup) {
            curSilentGroup.push(bc);
            if (!silentFails) {
              if (bcs === curSilentBlock) {
                silentGroups.push(curSilentGroup);
              }
              curSilentGroup = null;
            }
          }
          break;
        case op.FAIL:
        case op.CALL:
        case op.RULE:
          curSilentGroup = null;
          break;
        default:
          break;
      }
      if (InterpState.pushPops(bc, inspect, pop, push)) {
        absIp++;
        if (bc[0] === op.WHILE_NOT_ERROR) {
          const loopStart = absIp;
          const loopState = trackedState.slice();
          const loopInst = trackBlock(bc[1], loopState);
          // The loop body may not be executed, so only slots that it pushes and
          // pops can be discarded.
          handleSlots(loopInst, loopStart);
          merge(trackedState, null, loopState, null, loopStart);
        } else {
          const silentStart = silentFails;
          const condStart = absIp;
          const [thenCode, elseCode] = InterpState.getConditionalCode(bc);
          const thenState = trackedState.slice();
          const thenInst = handleSlots(
            trackBlock(thenCode, thenState), condStart
          );
          const thenEndInst = {
            container: thenCode, ip: thenCode.length, absIp: absIp - 1,
          };
          const silentEnd = silentFails;
          silentFails = silentStart;
          const elseInst = handleSlots(
            trackBlock(elseCode, trackedState), condStart
          );
          const elseEndInst = {
            container: elseCode, ip: elseCode.length, absIp: absIp - 1,
          };
          if (silentFails !== silentEnd) {
            throw new Error(`${name}: Mismatched SILENT_FAILS`);
          }
          for (let i = 0, j = 0; i < thenInst.length && j < elseInst.length;) {
            const ti = thenInst[i];
            const ej = elseInst[j];
            if (ti === ej) {
              foundSlots.push(ti);
            }
            if (ti.slot >= ej.slot) {
              i++;
            }
            if (ti.slot <= ej.slot) {
              j++;
            }
          }
          if (!elseCode.length && thenState.length > trackedState.length) {
            thenState.splice(trackedState.length);
          }
          merge(trackedState, elseEndInst, thenState, thenEndInst, condStart);
        }
        absIp--;
      }
      ip++;
      absIp++;
    }
    // Leave an empty slot at the end of each block where we can insert pops
    absIp++;
    return foundSlots;
  }

  const killedSlots = trackBlock(bcs, []);
  if (silentGroups.length) {
    silentGroups.flat().forEach(bc => bc.splice(0, bc.length, op.POP_N, 0));
  }
  if (!killedSlots.length) {
    return silentGroups.length !== 0;
  }

  /** @type {Record<number, TrackedSlot>} */
  const toDo = Object.create(null);
  killedSlots.forEach(slot => slot.instructions.forEach(inst => {
    // istanbul ignore next. This would only happen if there were bytecodes which
    // pushed more than one thing onto the stack.
    if (toDo[inst.absIp]) {
      throw new Error(`${name}: Bytecode at ${absIp} marked dead more than once`);
    }
    toDo[inst.absIp] = slot;
  }));

  /**
   *
   * @param {FormattedBytecode} bcs
   * @param {number} stackDepth
   * @param {number[]} inFlightKilledSlots
   */
  function applyKills(bcs, stackDepth, inFlightKilledSlots) {
    for (let ip = 0; ip < bcs.length; ip++) {
      const bc = bcs[ip];
      const aip = absIp;
      let pops = 0;
      let push = 0;
      const sd = stackDepth;
      const hasSubBlocks = InterpState.pushPops(bc, n => {
        // istanbul ignore next We constructed inFlightKilledSlots as slots that are never read
        if (inFlightKilledSlots[sd - n - 1] !== undefined) {
          throw new Error(`${name}: Bytecode at ${aip} read killed slot ${n}.`);
        }
      }, n => {
        pops += n;
      }, n => { push += n; });
      inFlightKilledSlots.forEach(slot => {
        InterpState.fixupForStackRemoval(bc, sd - slot - 1);
        if (!bc.length) {
          bcs.splice(ip, 1, [op.POP_N, 0]);
        }
      });
      if (pops) {
        stackDepth -= pops;
        if (stackDepth < inFlightKilledSlots.length) {
          inFlightKilledSlots.length = stackDepth;
        }
      }
      const toPush = toDo[aip];
      if (toPush) {
        // istanbul ignore next There are currently no bytecodes that push more than 1
        if (push !== 1) {
          throw new Error(`${name}: Expected bc at ${
            aip
          } to push exactly one element, but it pushed ${push}.`);
        }
        // istanbul ignore next We previously calculated the stack depth here; it can't have changed
        if (toPush.slot !== stackDepth) {
          throw new Error(`${name}: Bytecode did not push its output to the expected stack slot`);
        }
        inFlightKilledSlots[stackDepth] = stackDepth;
        bcs.splice(++ip, 0, [op.POP]);
        delete toDo[aip];
      }
      stackDepth += push;
      absIp++;
      if (hasSubBlocks) {
        if (bc[0] === op.WHILE_NOT_ERROR) {
          stackDepth = applyKills(bc[1], stackDepth, inFlightKilledSlots);
        } else {
          const [thenCode, elseCode] = InterpState.getConditionalCode(bc);
          const thenInFlight = inFlightKilledSlots.slice();
          const thenSD = applyKills(thenCode, stackDepth, thenInFlight);
          const elseSD = applyKills(elseCode, stackDepth, inFlightKilledSlots);
          if (thenSD !== elseSD) {
            // istanbul ignore next We checked this earlier
            if (thenSD < elseSD || elseCode.length) {
              throw new Error(`${name}: Stack Mismatch`);
            }
          }
          stackDepth = elseSD;
        }
      }
    }
    if (toDo[absIp]) {
      inFlightKilledSlots[stackDepth - 1] = stackDepth - 1;
      bcs.push([op.POP]);
      delete toDo[absIp];
    }
    absIp++;
    return stackDepth;
  }
  absIp = 0;
  applyKills(bcs, 0, []);
  return true;
}

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
      case op.TEXT:
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
    case op.POP_N:
      if (bc[ip][1] === 0) {
        result.bytecodeMods = {
          startOffset: ip,
          length: 1,
          replacements: [],
        };
        return result;
      }
      break;
    case op.PLUCK:
      if (bc[ip][1] === 1 && bc[ip][2] === 1 && bc[ip][3] === 0) {
        result.bytecodeMods = {
          startOffset: ip,
          length: 1,
          replacements: [],
        };
        return result;
      }
      break;
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
      if (nextBc && (nextBc[0] === op.POP
        || (nextBc[0] === op.POP_N && nextBc[1]))
      ) {
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
            startOffset: result.ip++,
            length: 1,
            replacements: [],
          };
          return result;
        }
        break;
      }
      case op.NIP:
      case op.POP_N:
      case op.POP: {
        let i = result.ip + 1;
        while (
          bc[i] && (
            bc[i][0] === op.NIP || bc[i][0] === op.POP || bc[i][0] === op.POP_N
          )
        ) {
          i++;
        }
        let first = true;
        InterpState.traverseCondState(
          bc[ip], result.condState, (state, block) => {
            const code = InterpState.formatBytecode(
              InterpState.flattenBc(bc.slice(result.ip, i))
            );
            state.run(code);
            block.push(...code);
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
          length: i - result.ip,
          replacements: [],
        };
        result.ip = i;
        return result;
      }

      default:
        break;
    }
  }
  return result;
}

/** @param {FormattedBytecode} bcs */
function pop_only(bcs) {
  return bcs.every(
    bc => bc[0] === op.POP || bc[0] === op.POP_N
  );
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
    case op.ACCEPT_N:
    case op.ACCEPT_STRING: {
      const next = bc[ip + 1];
      if (next && InterpState.killsStackAt(next, 0)
        && InterpState.killsCurrPos(bc, ip + 2)
      ) {
        bc.splice(ip, 1);
        InterpState.fixupForStackRemoval(next, 0);
        if (!next.length) {
          bc.splice(ip, 1, [op.POP_N, 0]);
        }
        const result = this.interp(bc, ip);
        result.bytecodeMods = true;
        return result;
      }
    }
    // Fallsthrough
    case op.RULE:
    case op.FAIL:
    case op.PUSH_EMPTY_ARRAY:
    case op.PUSH_EMPTY_STRING:
    case op.PUSH_FAILED:
    case op.PUSH_NULL:
    case op.PUSH_CURR_POS:
    case op.PUSH_UNDEFINED: {
      const next = bc[ip + 1];
      if (next) {
        if (next[0] === op.NIP) {
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
        if (next[0] === op.PLUCK && next[1] > 1
          && next[2] === 1 && next[3] === 0
        ) {
          // This plucks the top of the stack (which was just pushed by the
          // previous instruction) and drops some number of elements from just
          // below it. Its essentially a NIP, except it may discard more than
          // one element.
          this.discard(next[1] - 1);
          const result = this.interp(bc, ip);
          result.bytecodeMods = {
            startOffset: ip,
            length: 2,
            replacements: [[op.POP_N, next[1] - 1], cur],
          };
          result.ip++;
          return result;
        }
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
      if (next && InterpState.killsStackAt(next, 0)) {
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
      if (InterpState.killsStackAt(next, 0)) {
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
      if (InterpState.killsStackAt(next, 0)) {
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

    case op.POP: {
      const next = bc[ip + 1];
      if (!next) {
        break;
      }
      const top = this.top();
      if (top.type & (TypeTag.UNDEFINED | TypeTag.NULL | TypeTag.FAILED)
          && !(top.type & (top.type - 1))
      ) {
        switch (next[0]) {
          case op.PUSH_UNDEFINED:
            if (top.type !== TypeTag.UNDEFINED) {
              return null;
            }
            break;
          case op.PUSH_NULL:
            if (top.type !== TypeTag.NULL) {
              return null;
            }
            break;
          case op.PUSH_FAILED:
            if (top.type !== TypeTag.FAILED) {
              return null;
            }
            break;
          default:
            return null;
        }
        return {
          ip: ip + 2,
          bytecodeMods: {
            startOffset: ip,
            length: 2,
            replacements: [],
          },
        };
      }
      break;
    }

    case op.IF:                 // IF t, f
    case op.IF_ERROR:           // IF_ERROR t, f
    case op.IF_NOT_ERROR:       // IF_NOT_ERROR t, f
    case op.IF_LT:              // IF_LT min, t, f
    case op.IF_GE:              // IF_GE max, t, f
    case op.IF_LT_DYNAMIC:      // IF_LT_DYNAMIC min, t, f
    case op.IF_GE_DYNAMIC:      // IF_GE_DYNAMIC max, t, f
    case op.MATCH_ANY:          // MATCH_ANY a, f, ...
    case op.MATCH_STRING:       // MATCH_STRING s, a, f, ...
    case op.MATCH_STRING_IC:    // MATCH_STRING_IC s, a, f, ...
    case op.MATCH_CHAR_CLASS: { // MATCH_CHAR_CLASS c, a, f, ...
      const [thenCode, elseCode] = InterpState.getConditionalCode(cur);
      if (pop_only(thenCode) && pop_only(elseCode)) {
        bc.splice(ip, 1, ...elseCode);
        return {
          ip,
          bytecodeMods: true,
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
 * @param {PEG.ast.Grammar | null} ast - The Grammar we're working on
 * @param {number[]} bytecode          - The bytecode to optimize
 * @param {string}   name              - Name for error reporting purposes
 * @param {boolean}  [log]             - Whether to report changes to the bytecode
 * @param {boolean}  [nodead]          - Whether to report changes to the bytecode
 * @returns {number[]}
 */
function optimizeBlock(ast, bytecode, name, log, nodead) {
  const dolog = log || logging;
  const fbc = InterpState.formatBytecode(bytecode);
  let changes = false;
  for (;;) {
    const state = new InterpState(name, ast);
    state.postInterp = postInterp;
    state.preInterp = preInterp;
    if (!state.run(fbc).changes) {
      if (nodead || !deadSlotRemoval(name, fbc)) {
        break;
      }
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
  deadSlotRemoval,
};
