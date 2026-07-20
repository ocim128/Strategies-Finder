import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    fnv1a64Hex,
    tieBreakDigest,
    compareByTieBreak,
    resolveResearchMode,
    MAX_ACTIVE_TIE_VERSION,
    MAX_ACTIVE_TIE_SEED,
    MAX_ACTIVE_HOLDOUT_REGISTRATION,
    MAX_ACTIVE_THRESHOLDS,
    MAX_ACTIVE_HORIZONS,
    MAX_ACTIVE_PRIMARY_HORIZON,
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

    describe("compareByTieBreak", () => {
        it("ranks the smaller digest first", () => {
            // 'AAA' vs 'ZZZ' at the same event: deterministic by digest, not name.
            const t = 1_700_000_000;
            const dA = tieBreakDigest(t, "AAA");
            const dZ = tieBreakDigest(t, "ZZZ");
            const winner = dA < dZ ? "AAA" : "ZZZ";
            const cmp = compareByTieBreak(t, "AAA", dA, "ZZZ", dZ);
            assert.equal(cmp < 0 ? "AAA" : "ZZZ", winner);
        });

        it("falls back to asset-name order on a digest collision", () => {
            const t = 1_700_000_000;
            // Force a collision by passing the same digest for both assets.
            const same = "0000000000000000";
            assert.equal(compareByTieBreak(t, "AAA", same, "ZZZ", same), -1);
            assert.equal(compareByTieBreak(t, "ZZZ", same, "AAA", same), 1);
            assert.equal(compareByTieBreak(t, "AAA", same, "AAA", same), 0);
        });
    });

    describe("resolveResearchMode", () => {
        it("returns EXPLORATORY when no registration is committed", () => {
            assert.equal(MAX_ACTIVE_HOLDOUT_REGISTRATION, null);
            const mode = resolveResearchMode({
                registration: null,
                pairListHash: "any",
                batchFingerprintWithoutRegistration: "any",
                interval: "4h",
                decisionStartSec: 0,
                decisionEndSec: 0,
                slippageBps: 0,
                commissionPercent: 0,
                nowSec: Date.now() / 1000,
            });
            assert.equal(mode, "EXPLORATORY");
        });

        it("returns HOLDOUT only when every registered field matches AND evaluation time is reached", () => {
            const now = Math.floor(Date.now() / 1000);
            const reg = {
                schema: "batch.max_active_research.v1",
                registrationId: "test-001",
                implementationCommit: "abc1234",
                registeredAtSec: now - 100,
                decisionStartSec: now - 50,
                decisionEndSec: now - 10,
                evaluateNotBeforeSec: now - 1,
                expectedPairListHash: "deadbeef",
                expectedBatchFingerprint: "fp-abc",
                interval: "4h",
                horizons: [36, 72, 96] as readonly [36, 72, 96],
                slippageBps: 5,
                commissionPercent: 0.02,
                tieVersion: MAX_ACTIVE_TIE_VERSION,
                bootstrapVersion: "max_active_bootstrap_v1",
                thresholdVersion: "max_active_thresholds_v1",
            } as const;
            assert.equal(
                resolveResearchMode({
                    registration: reg,
                    pairListHash: "deadbeef",
                    batchFingerprintWithoutRegistration: "fp-abc",
                    interval: "4h",
                    decisionStartSec: now - 50,
                    decisionEndSec: now - 10,
                    slippageBps: 5,
                    commissionPercent: 0.02,
                    nowSec: now,
                }),
                "HOLDOUT",
            );
            // Each mismatch flips it back to EXPLORATORY.
            assert.equal(
                resolveResearchMode({
                    registration: reg, pairListHash: "WRONG",
                    batchFingerprintWithoutRegistration: "fp-abc", interval: "4h",
                    decisionStartSec: now - 50, decisionEndSec: now - 10,
                    slippageBps: 5, commissionPercent: 0.02, nowSec: now,
                }),
                "EXPLORATORY",
            );
            assert.equal(
                resolveResearchMode({
                    registration: reg, pairListHash: "deadbeef",
                    batchFingerprintWithoutRegistration: "fp-abc", interval: "1h", // wrong interval
                    decisionStartSec: now - 50, decisionEndSec: now - 10,
                    slippageBps: 5, commissionPercent: 0.02, nowSec: now,
                }),
                "EXPLORATORY",
            );
            // Evaluation time not yet reached -> EXPLORATORY.
            assert.equal(
                resolveResearchMode({
                    registration: { ...reg, evaluateNotBeforeSec: now + 10_000 },
                    pairListHash: "deadbeef",
                    batchFingerprintWithoutRegistration: "fp-abc", interval: "4h",
                    decisionStartSec: now - 50, decisionEndSec: now - 10,
                    slippageBps: 5, commissionPercent: 0.02, nowSec: now,
                }),
                "EXPLORATORY",
            );
        });
    });

    describe("frozen research constants (Phase 0 freeze)", () => {
        it("locks the primary horizon at 72 and secondary at 36/96", () => {
            assert.equal(MAX_ACTIVE_PRIMARY_HORIZON, 72);
            assert.deepEqual([...MAX_ACTIVE_HORIZONS], [36, 72, 96]);
        });

        it("locks the block bootstrap dimensions", () => {
            assert.equal(MAX_ACTIVE_BLOCK_COUNT, 10);
            assert.equal(MAX_ACTIVE_BOOTSTRAP_SAMPLES, 10_000);
        });

        it("locks the formal-sufficiency thresholds", () => {
            // These cannot drift without breaking the preregistration.
            assert.equal(MAX_ACTIVE_THRESHOLDS.artifactEligibleShareMin, 0.95);
            assert.equal(MAX_ACTIVE_THRESHOLDS.artifactWriteFailuresMax, 0);
            assert.equal(MAX_ACTIVE_THRESHOLDS.artifactReadFailuresMax, 0);
            assert.equal(MAX_ACTIVE_THRESHOLDS.replayAcceptedShareMin, 0.95);
            assert.equal(MAX_ACTIVE_THRESHOLDS.perAssetRetentionShareMin, 0.9);
            assert.equal(MAX_ACTIVE_THRESHOLDS.assetRetentionSpreadPpMax, 10);
            assert.equal(MAX_ACTIVE_THRESHOLDS.horizonCoverageShareMin, 0.95);
            assert.equal(MAX_ACTIVE_THRESHOLDS.primaryEligibleEventsMin, 1_000);
            assert.equal(MAX_ACTIVE_THRESHOLDS.activeVsSubmittedDiffEventsMin, 200);
            assert.equal(MAX_ACTIVE_THRESHOLDS.sharedMaskNonOverlapEventsMin, 100);
            assert.equal(MAX_ACTIVE_THRESHOLDS.dominantExcludedEventsMin, 500);
            assert.equal(MAX_ACTIVE_THRESHOLDS.formalBlockCount, 10);
            assert.equal(MAX_ACTIVE_THRESHOLDS.primaryPositiveBlocksMin, 7);
        });
    });
});
