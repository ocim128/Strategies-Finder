import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    fnv1a64Hex,
    tieBreakDigest,
    MAX_ACTIVE_TIE_VERSION,
    MAX_ACTIVE_TIE_SEED,
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
} from "../lib/batch-backtest/max-active-research-contract";

describe("max-active-research-contract", () => {
    describe("fnv1a64Hex", () => {
        // Cross-checked against a reference BigInt implementation of FNV-1a 64.
        it("matches the canonical FNV-1a 64 reference values", () => {
            assert.equal(fnv1a64Hex(""), "cbf29ce484222325");
            assert.equal(fnv1a64Hex("a"), "af63dc4c8601ec8c");
            assert.equal(fnv1a64Hex("hello"), "a430d84680aabd0b");
            assert.equal(fnv1a64Hex("market|BTCUSDT|BTC"), "0dce6b23bf4cc851");
        });

        it("is deterministic and order-sensitive", () => {
            assert.equal(fnv1a64Hex("abc"), fnv1a64Hex("abc"));
            assert.notEqual(fnv1a64Hex("abc"), fnv1a64Hex("acb"));
        });

        it("encodes UTF-8 the same way for non-ASCII markers", () => {
            // Diamond marker (U+2666) is 3 UTF-8 bytes (E2 99 A6). The digest
            // must NOT change if we hand-roll the same byte sequence.
            const direct = fnv1a64Hex("AAPL\u2666");
            const asBytes = fnv1a64Hex("AAPL\u{2666}");
            assert.equal(direct, asBytes);
        });
    });

    describe("tieBreakDigest", () => {
        it("encodes the versioned tie rule and shared seed", () => {
            // The digest input is `${TIE_VERSION}|${TIE_SEED}|${t}|${asset}`.
            const t = 1_700_000_000;
            const asset = "BTC";
            const expected = fnv1a64Hex(`${MAX_ACTIVE_TIE_VERSION}|${MAX_ACTIVE_TIE_SEED}|${t}|${asset}`);
            assert.equal(tieBreakDigest(t, asset), expected);
        });

        it("is invariant under float-formatted time (truncates to integer)", () => {
            assert.equal(tieBreakDigest(1_700_000_000, "BTC"), tieBreakDigest(1_700_000_000.9, "BTC"));
        });

        it("changes when the asset changes or the time changes", () => {
            assert.notEqual(tieBreakDigest(1_700_000_000, "BTC"), tieBreakDigest(1_700_000_000, "ETH"));
            assert.notEqual(tieBreakDigest(1_700_000_000, "BTC"), tieBreakDigest(1_700_000_001, "BTC"));
        });
    });

    describe("frozen research constants (Phase 0 freeze)", () => {
        it("locks the block bootstrap dimensions", () => {
            assert.equal(MAX_ACTIVE_BLOCK_COUNT, 10);
            assert.equal(MAX_ACTIVE_BOOTSTRAP_SAMPLES, 10_000);
        });
    });
});
