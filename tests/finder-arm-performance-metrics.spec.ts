import { expect } from "chai";
import { describe, it } from "node:test";
import {
    FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
    buildFinderArmPerformanceMetrics,
    buildFinderArmPerformanceMetricsFromArms,
    compactFinderArmComparison,
    getFinderArmPerformanceRankValue,
    sortFinderArmPerformanceResults,
} from "../lib/finder/finder-arm-performance-metrics";
import type { ReplayComparison } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

function comparison(value: number | null, events = 3): ReplayComparison {
    return {
        events,
        topMean: value,
        randomMean: value,
        delta: value,
        topMedian: value,
        blockMeans: [value ?? 0],
        ciLower: value,
        ciUpper: value,
        positiveBlocks: 1,
        totalBlocks: 2,
    };
}

describe("Finder Arm Performance metrics", () => {
    it("maps every replay field into its named compact arm metric", () => {
        const horizon: Record<string, ReplayComparison> = {};
        let value = -7;
        for (const field of Object.values(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS)) {
            horizon[field] = comparison(value);
            value += 1;
        }
        const metrics = buildFinderArmPerformanceMetrics(horizon as never);
        value = -7;
        for (const [arm] of Object.entries(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS)) {
            expect(metrics[arm as keyof typeof metrics].topMean).to.equal(value);
            value += 1;
        }
        expect(metrics.TOP_RAW_PROFIT_NOW).not.to.have.property("blockMeans");
    });

    it("compacts the coordinator's already arm-keyed summaries", () => {
        const comparisons = Object.fromEntries(
            (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS>)
                .map((arm, index) => [arm, comparison(index)]),
        );
        const metrics = buildFinderArmPerformanceMetricsFromArms(comparisons as never);
        for (const [index, arm] of (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS>).entries()) {
            expect(metrics[arm].topMean).to.equal(index);
        }
    });

    it("keeps finite zero and negative means while treating null and zero events as unavailable", () => {
        expect(getFinderArmPerformanceRankValue({ TOP_RAW: compactFinderArmComparison(comparison(-2)) }, "TOP_RAW"))
            .to.equal(-2);
        expect(getFinderArmPerformanceRankValue({ TOP_RAW: compactFinderArmComparison(comparison(0)) }, "TOP_RAW"))
            .to.equal(0);
        expect(getFinderArmPerformanceRankValue({ TOP_RAW: compactFinderArmComparison(comparison(null)) }, "TOP_RAW"))
            .to.equal(null);
        expect(getFinderArmPerformanceRankValue({ TOP_RAW: compactFinderArmComparison(comparison(4, 0)) }, "TOP_RAW"))
            .to.equal(null);
        expect(compactFinderArmComparison({ ...comparison(1), topMean: Number.NaN }).topMean).to.equal(null);
    });

    it("sorts a copy of the full inventory, with stable ties and unavailable values last", () => {
        const source = [
            { candidateOrdinal: 0, id: "first", metrics: { TOP_RAW: compactFinderArmComparison(comparison(1)) } },
            { candidateOrdinal: 1, id: "tie", metrics: { TOP_RAW: compactFinderArmComparison(comparison(1)) } },
            { candidateOrdinal: 2, id: "unavailable", metrics: { TOP_RAW: compactFinderArmComparison(comparison(null)) } },
            { candidateOrdinal: 3, id: "winner-below-display-prefix", metrics: { TOP_RAW: compactFinderArmComparison(comparison(5)) } },
        ];
        const sorted = sortFinderArmPerformanceResults(source, "TOP_RAW");
        expect(sorted.map((row) => row.id)).to.deep.equal([
            "winner-below-display-prefix",
            "first",
            "tie",
            "unavailable",
        ]);
        expect(source.map((row) => row.id)).to.deep.equal(["first", "tie", "unavailable", "winner-below-display-prefix"]);
        expect(sorted).not.to.equal(source);
    });
});
