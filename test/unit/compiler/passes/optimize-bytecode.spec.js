// @ts-check
"use strict";

const chai = require("chai");
const op = require("../../../../lib/compiler/opcodes");
const { optimizeBlock } = require("../../../../lib/compiler/passes/optimize-bytecode");
const { InterpState } = require("../../../../lib/compiler/interp-state");

const expect = chai.expect;

describe("compiler pass |optimizeBytecode|", () => {
  const flattenBc = InterpState.flattenBc;
  describe("combine consecutive ifs", () => {
    it("conditional => op.IF no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_EMPTY_ARRAY],
          ], [
            [op.PUSH_NULL],
          ],
        ],
        [
          op.IF, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF")).to.deep.equal(flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_EMPTY_ARRAY],
            [op.ACCEPT_N, 1],
          ], [
            [op.PUSH_NULL],
            [op.FAIL, 0],
          ],
        ],
      ]));
    });
    it("conditional => op.IF swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_NULL],
          ], [
            [op.PUSH_EMPTY_ARRAY],
          ],
        ],
        [
          op.IF, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF")).to.deep.equal(flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_NULL],
            [op.FAIL, 0],
          ], [
            [op.PUSH_EMPTY_ARRAY],
            [op.ACCEPT_N, 1],
          ],
        ],
      ]));
    });

    it("conditional => op.IF_ERROR no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_FAILED],
          ], [
            [op.PUSH_NULL],
          ],
        ],
        [
          op.IF_ERROR, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_FAILED],
            [op.ACCEPT_N, 1],
          ], [
            [op.PUSH_NULL],
            [op.FAIL, 0],
          ],
        ],
      ]));
    });
    it("conditional => op.IF_ERROR swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_NULL],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
        [
          op.IF_ERROR, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_NULL],
            [op.FAIL, 0],
          ], [
            [op.PUSH_FAILED],
            [op.ACCEPT_N, 1],
          ],
        ],
      ]));
    });

    it("conditional => op.IF_NOT_ERROR no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_FAILED],
          ], [
            [op.PUSH_NULL],
          ],
        ],
        [
          op.IF_NOT_ERROR, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF_NOT_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_FAILED],
            [op.FAIL, 0],
          ], [
            [op.PUSH_NULL],
            [op.ACCEPT_N, 1],
          ],
        ],
      ]));
    });
    it("conditional => op.IF_NOT_ERROR swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_NULL],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
        [
          op.IF_NOT_ERROR, [
            [op.ACCEPT_N, 1],
          ], [
            [op.FAIL, 0],
          ],
        ],
      ]), "combine-with-IF_NOT_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_NULL],
            [op.ACCEPT_N, 1],
          ], [
            [op.PUSH_FAILED],
            [op.FAIL, 0],
          ],
        ],
      ]));
    });
  });
  describe("combine consecutive ifs with second else empty", () => {
    it("conditional => op.IF no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_CURR_POS],
          ], [
            [op.PUSH_NULL],
          ],
        ],
        [
          op.IF, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF")).to.deep.equal(flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_CURR_POS],
            [
              op.IF, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ], [
            [op.PUSH_NULL],
          ],
        ],
      ]));
    });
    it("conditional => op.IF swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_NULL],
          ], [
            [op.PUSH_CURR_POS],
          ],
        ],
        [
          op.IF, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF")).to.deep.equal(flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.PUSH_NULL],
          ], [
            [op.PUSH_CURR_POS],
            [
              op.IF, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ],
        ],
      ]));
    });
    it("conditional => op.IF no merge", () => {
      const codes = flattenBc([
        [
          op.MATCH_CHAR_CLASS, 0, [
            [op.CALL, 0, 0, 0],
          ], [
            [op.PUSH_CURR_POS],
          ],
        ],
        [
          op.IF, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]);
      expect(optimizeBlock(null, codes, "combine-with-IF")).to.deep.equal(codes);
    });

    it("conditional => op.IF_ERROR no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.RULE, 0],
          ], [
            [op.PUSH_NULL],
          ],
        ],
        [
          op.IF_ERROR, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.RULE, 0],
            [
              op.IF_ERROR, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ], [
            [op.PUSH_NULL],
          ],
        ],
      ]));
    });
    it("conditional => op.IF_ERROR swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_NULL],
          ], [
            [op.RULE, 0],
          ],
        ],
        [
          op.IF_ERROR, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING, 0, [
            [op.PUSH_NULL],
          ], [
            [op.RULE, 0],
            [
              op.IF_ERROR, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ],
        ],
      ]));
    });

    it("conditional => op.IF_NOT_ERROR no swap", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_FAILED],
          ], [
            [op.RULE, 0],
          ],
        ],
        [
          op.IF_NOT_ERROR, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF_NOT_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.PUSH_FAILED],
          ], [
            [op.RULE, 0],
            [
              op.IF_NOT_ERROR, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ],
        ],
      ]));
    });
    it("conditional => op.IF_NOT_ERROR swapped", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.RULE, 0],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
        [
          op.IF_NOT_ERROR, [
            [op.ACCEPT_N, 1],
            [op.POP],
          ], [],
        ],
      ]), "combine-with-IF_NOT_ERROR")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.RULE, 0],
            [
              op.IF_NOT_ERROR, [
                [op.ACCEPT_N, 1],
                [op.POP],
              ], [],
            ],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
      ]));
    });
  });
  describe("Optimize FAIL opcodes", () => {
    it("to PUSH_FAILURE when SILENT_FAILS is on", () => {
      expect(optimizeBlock(null, [
        op.SILENT_FAILS_ON,
        op.FAIL, 1,
        op.SILENT_FAILS_OFF,
      ], "fail-in-silent").includes(op.PUSH_FAILED)).to.equal(true);
    });
    it("to NOP when discarded and SILENT_FAILS is on", () => {
      expect(optimizeBlock(null, [
        op.SILENT_FAILS_ON,
        op.FAIL, 1,
        op.POP,
        op.SILENT_FAILS_OFF,
      ], "dead-fail-in-silent").length).to.be.lessThanOrEqual(2);
    });
  });
  describe("Optimize PUSH/POP pairs", () => {
    it("with separate POPs", () => {
      expect(optimizeBlock(null, [
        op.PUSH_NULL,
        op.PUSH_UNDEFINED,
        op.PUSH_EMPTY_ARRAY,
        op.PUSH_EMPTY_STRING,
        op.POP,
        op.POP,
        op.POP,
        op.POP,
      ], "dead-push-pops")).to.deep.equal([]);
    });
    it("with POP_N", () => {
      expect(optimizeBlock(null, [
        op.PUSH_NULL,
        op.PUSH_UNDEFINED,
        op.PUSH_EMPTY_ARRAY,
        op.PUSH_EMPTY_STRING,
        op.POP_N, 4,
      ], "dead-push-pops")).to.deep.equal([]);
    });
    it("NIP/POP => POP", () => {
      expect(optimizeBlock(null, [
        op.PUSH_FAILED,
        op.PUSH_NULL,
        op.PUSH_CURR_POS,
        op.POP_CURR_POS,
        op.NIP,
        op.POP,
      ], "dead-nip-pops")).to.deep.equal([]);
    });
    it("PUSH/NIP => POP/PUSH", () => {
      expect(optimizeBlock(null, [
        op.PUSH_FAILED,
        op.PUSH_NULL,
        op.NIP,
      ], "dead-push-nips")).to.deep.equal([op.PUSH_NULL]);
    });
    it("PLUCK n/POP => POP_N/POP", () => {
      expect(optimizeBlock(null, [
        op.PUSH_FAILED,
        op.PUSH_NULL,
        op.PUSH_EMPTY_ARRAY,
        op.PLUCK, 3, 1, 1,
        op.POP,
      ], "dead-pluck-popn")).to.deep.equal([]);
    });
    it("PLUCK 1/POP => POP", () => {
      expect(optimizeBlock(null, [
        op.PUSH_FAILED,
        op.PLUCK, 1, 1, 0,
        op.POP,
      ], "dead-pluck-pop1")).to.deep.equal([]);
    });
    it("PLUCK 0/POP => PUSH_NULL/POP", () => {
      expect(optimizeBlock(null, [
        op.PUSH_FAILED,
        op.PLUCK, 0, 1, 0,
        op.POP,
      ], "dead-pluck-pop0")).to.deep.equal([op.PUSH_FAILED]);
    });
  });
  describe("kill useless POP_CURR_POS", () => {
    it("when currPos is unchanged", () => {
      expect(optimizeBlock(null, [
        op.PUSH_CURR_POS,
        op.FAIL, 1,
        op.POP,
        op.POP_CURR_POS,
      ], "unchanged-curr-pos").includes(op.POP_CURR_POS)).to.equal(false);
    });
    it("when currPos subsequently killed", () => {
      expect(optimizeBlock(null, [
        op.PUSH_CURR_POS,
        op.ACCEPT_N, 1,
        op.PUSH_CURR_POS,
        op.ACCEPT_N, 1,
        op.PUSH_CURR_POS,
        op.ACCEPT_N, 1,
        op.POP,
        op.POP_CURR_POS,
        op.FAIL, 1,
        op.POP,
        op.POP,
        op.POP_CURR_POS,
        op.POP,
        op.POP_CURR_POS,
      ], "unchanged-curr-pos").filter(
        b => b === op.POP_CURR_POS
      ).length).to.equal(1);
    });
  });
  describe("WHILE_NOT_FAILED", () => {
    it("is removed when always fails", () => {
      expect(optimizeBlock(null, flattenBc([
        [op.PUSH_FAILED],
        [op.WHILE_NOT_ERROR, [
          [op.POP],
          [op.ACCEPT_N, 1],
        ]],
        [op.POP],
      ]), "dead-while-loop")).to.deep.equal([]);
    });
    it("is hoisted when one if branch always fails", () => {
      expect(optimizeBlock(null, flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.ACCEPT_N, 1],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
        [op.WHILE_NOT_ERROR, [
          [op.POP],
          [
            op.MATCH_STRING_IC, 0, [
              [op.ACCEPT_N, 1],
            ], [
              [op.PUSH_FAILED],
            ],
          ],
        ]],
        [op.POP],
      ]), "hoisted-while-loop")).to.deep.equal(flattenBc([
        [
          op.MATCH_STRING_IC, 0, [
            [op.ACCEPT_N, 1],
            [op.WHILE_NOT_ERROR, [
              [op.POP],
              [
                op.MATCH_STRING_IC, 0, [
                  [op.ACCEPT_N, 1],
                ], [
                  [op.PUSH_FAILED],
                ],
              ],
            ]],
          ], [
            [op.PUSH_FAILED],
          ],
        ],
        [op.POP],
      ]));
    });
  });
  describe("SILENT_FAILS", () => {
    it("are killed when nested", () => {
      expect(optimizeBlock(null, [
        op.SILENT_FAILS_ON,
        op.SILENT_FAILS_ON,
        op.RULE, 1,
        op.SILENT_FAILS_OFF,
        op.SILENT_FAILS_OFF,
      ], "nested-silent")).to.be.deep.equal([
        op.SILENT_FAILS_ON,
        op.RULE, 1,
        op.SILENT_FAILS_OFF,
      ]);
    });
  });
  describe("logging", () => {
    const spy = jest.spyOn(console, "log");
    expect(optimizeBlock(null, [
      op.PUSH_NULL,
      op.POP,
    ], "logging", true)).to.deep.equal([]);
    expect(spy.mock.calls.length).to.be.equal(4);
  });
});
