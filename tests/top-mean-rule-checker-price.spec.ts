import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    TOP_MEAN_RULE_PRICE_FIELDS,
    computeTopMeanFeatureStats,
    evaluateTopMeanCausalScreen,
    normalizeTopMeanArchive,
    renderTopMeanFeatureStatsReport,
    type TopMeanRuleArchiveMeta,
} from "../scripts/top-mean-rule-checker";
import {
    TOP_MEAN_PRICE_FEATURE_FIELDS,
    type TopMeanPriceFeatureRow,
} from "../scripts/lib/top-mean-price-features";
import { computeTopMeanPriceCalibration } from "../scripts/top-mean-price-calibration";
import type { TopMeanPriceManifest } from "../scripts/build-top-mean-price-features";
import { MAX_ACTIVE_BLOCK_COUNT, MAX_ACTIVE_BOOTSTRAP_SAMPLES, MAX_ACTIVE_BOOTSTRAP_SEED, MAX_ACTIVE_TIE_VERSION } from "../lib/batch-backtest/max-active-research-contract";
import type { PoolSnapshotRecord } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { PoolRuleArchive } from "../scripts/analyze-pool-rules";

const TIME = 1_740_000_000;

function snapshot(asset: string, score: number): PoolSnapshotRecord {
    return { eventId: `4h:${TIME}`, decisionTimeSec: TIME, interval: "4h", poolVersion: null, asset, inPool: true, activePairCount: 10, signedVotes: score * 10, score, longEligible: true, shortEligible: false, ema200Above: true, breadth: 0.5, regime: "bullish" };
}

function price(asset: string, value: number | null): TopMeanPriceFeatureRow {
    return { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset, priceResidualMomentum5: value, priceReversalRate5: 0.2, priceVolExpansion5: null, priceRelativeVolume1: 0, priceGapFollowThrough20: 0.1, priceCatalogCorrelation20: 0.2 };
}

function meta(schema: "top_mean_archive.v2" | "top_mean_archive.v3" = "top_mean_archive.v3"): TopMeanRuleArchiveMeta {
    return {
        schema,
        runId: "price-fixture",
        interval: "4h",
        horizons: [24],
        canonicalAssets: ["AAA", "BBB"],
        manifest: { catalog: { assets: ["AAA", "BBB"] }, researchContract: { tieVersion: MAX_ACTIVE_TIE_VERSION, blockCount: MAX_ACTIVE_BLOCK_COUNT, bootstrapSamples: MAX_ACTIVE_BOOTSTRAP_SAMPLES, bootstrapSeed: MAX_ACTIVE_BOOTSTRAP_SEED } },
    };
}

function archive(schema: "top_mean_archive.v2" | "top_mean_archive.v3" = "top_mean_archive.v3"): PoolRuleArchive {
    return { meta: meta(schema), snapshots: [snapshot("AAA", 0.8), snapshot("BBB", 0.7)], outcomes: [], eventRows: [] };
}

describe("TOP_MEAN price checker integration", () => {
    it("opens only the explicit price allowlist and tracks price reads separately", () => {
        const normalized = normalizeTopMeanArchive({ archive: archive(), reportText: "fixture", features: [
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "AAA", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "BBB", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
        ], priceFeatures: [price("AAA", null), price("BBB", 2)] });
        const screen = evaluateTopMeanCausalScreen({ archive: normalized, window: "discovery", rule: (candidate) => candidate.priceResidualMomentum5 ?? candidate.score ?? 0 });
        assert.deepEqual(screen.accessedV2Fields, []);
        assert.deepEqual(screen.accessedPriceFields, ["priceResidualMomentum5"]);
        assert.equal(screen.nullReads, 1);
        assert.equal(screen.nullNeutralViolations, 0);
        assert.equal(screen.changedEvents, 1);
        assert.equal(screen.priceFieldsFullyObservedEvents, 0);
        assert.throws(() => evaluateTopMeanCausalScreen({ archive: normalizeTopMeanArchive({ archive: archive("top_mean_archive.v2"), reportText: "fixture" }), window: "discovery", rule: (candidate) => candidate.priceResidualMomentum5 ?? candidate.score ?? 0 }), /forbidden candidate field/);
    });

    it("keeps null price filters neutral and reports all six price distributions", () => {
        const normalized = normalizeTopMeanArchive({ archive: archive(), reportText: "fixture", features: [
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "AAA", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "BBB", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
        ], priceFeatures: [price("AAA", null), price("BBB", 2)] });
        const filter = evaluateTopMeanCausalScreen({ archive: normalized, window: "discovery", rule: (candidate) => { const value = candidate.priceResidualMomentum5; return value == null ? true : value > 0; } });
        assert.equal(filter.nullNeutralViolations, 0);
        assert.deepEqual(TOP_MEAN_RULE_PRICE_FIELDS, TOP_MEAN_PRICE_FEATURE_FIELDS);
        const stats = computeTopMeanFeatureStats(normalized, "discovery");
        const report = renderTopMeanFeatureStatsReport(normalized, stats);
        for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) assert.match(report, new RegExp(`FEATURE \\| name=${field} `));
    });

    it("admits sparse fixtures under v1.5 relaxation; categorical targets remain UNVERIFIED", () => {
        const normalized = normalizeTopMeanArchive({ archive: archive(), reportText: "fixture", features: [
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "AAA", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
            { eventId: `4h:${TIME}`, decisionTimeSec: TIME, asset: "BBB", priorCoverageSlope5: 1, priorSignedVoteDelta3: 1, priorScoreStdDev5: 1, priorTopMeanReturnMean3: 1 },
        ], priceFeatures: [price("AAA", 1), price("BBB", 2)] });
        const calibration = computeTopMeanPriceCalibration({
            ...normalized,
            priceManifest: { enrichmentId: "a".repeat(64) } as unknown as TopMeanPriceManifest,
        }, "discovery");
        assert.equal(calibration.fields.priceResidualMomentum5!.correlations.raw.regimeBullish.status, "UNVERIFIED");
        assert.deepEqual(calibration.admittedFields, [...TOP_MEAN_PRICE_FEATURE_FIELDS]);
    });
});
