import { expect } from "chai";
import { describe, it } from "node:test";
import { buildTopMeanHorizonSummaries } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import type {
    OpenScoreUsdReplayResult,
    ReplayComparison,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { FINDER_ARM_PERFORMANCE_REPLAY_FIELDS } from "../lib/finder/finder-arm-performance-metrics";

function comparison(events: number): ReplayComparison {
    return {
        events,
        topMean: events,
        randomMean: events,
        delta: events,
        topMedian: events,
        blockMeans: [],
        ciLower: events,
        ciUpper: events,
        positiveBlocks: events,
        totalBlocks: 10,
    };
}

describe("buildTopMeanHorizonSummaries", () => {
    it("maps all requested arm names to their own comparisons", () => {
        const replayHorizon: Record<string, unknown> = {
            bars: 24,
            topMeanByAsset: [
                { asset: "BBB", events: 2, share: 0.5, topMean: 0, randomMean: 0, delta: 0 },
                { asset: "AAA", events: 2, share: 0.5, topMean: 0, randomMean: 0, delta: 0 },
            ],
        };
        const expected = new Map<string, number>();
        let value = 1;
        for (const [arm, field] of Object.entries(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS)) {
            replayHorizon[field] = comparison(value);
            expected.set(arm, value);
            value += 1;
        }

        const result = { horizons: [replayHorizon] } as unknown as OpenScoreUsdReplayResult;

        const summaries = buildTopMeanHorizonSummaries(result);
        expect(summaries).to.have.lengthOf(1);
        const summary = summaries[0]!;
        expect(summary.horizon).to.equal(24);
        expect(summary.events).to.equal(6);
        for (const [arm, events] of expected) {
            expect(summary.armComparisons?.[arm as keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS]?.events)
                .to.equal(events, `${arm} should retain its replay comparison`);
        }
        // topAssets stays sorted by events desc, then asset name.
        expect(summary.topAssets.map((asset) => asset.asset)).to.deep.equal(["AAA", "BBB"]);
    });
});
