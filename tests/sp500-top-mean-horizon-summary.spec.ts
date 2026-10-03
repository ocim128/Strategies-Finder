import { expect } from "chai";
import { describe, it } from "node:test";
import { buildTopMeanHorizonSummaries, toWireSafeTopMeanResultSummary, type TopMeanResultSummary } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import { createEmptyRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import type {
    OpenScoreUsdReplayResult,
    ReplayComparison,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { FINDER_ARM_PERFORMANCE_REPLAY_FIELDS } from "../lib/finder/finder-arm-performance-metrics";
import { renderTopMeanResults } from "../lib/batch-backtest/browser/top-mean-results-view";

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
    it("keeps ranking scalar summaries on the coordinator wire without diagnostic arrays", () => {
        const rankingMeasurement = createEmptyRankingMeasurement(20);
        Object.assign(rankingMeasurement.arms.topRaw, { scoredEvents: 200, eligibleEvents: 200, comparisons: 2000, meanAccuracy: 0.6, top1Superiority: 0.65,
            ciLower: 0.5, ciUpper: 0.7, blockCount: 12, measurementWindowSec: 10, timeBlockWidthSec: 20, timeCoverageSec: 250, soleFirstPlaceCount: 40, sharedFirstPlaceCount: 30, soleFirstPlaceRate: 0.2, sharedFirstPlaceRate: 0.15, status: "available" });
        Object.assign(rankingMeasurement, { eventRows: [1, 2, 3] });
        const summary = { rankingMeasurement, horizons: [], counts: {}, reportLines: [], warnings: [], poolSnapshots: [1], candidateOutcomes: [1] } as unknown as TopMeanResultSummary;
        const wire = toWireSafeTopMeanResultSummary(summary);
        expect(wire.rankingMeasurement?.arms.topRaw).to.include({ status: "available", scoredEvents: 200, blockCount: 12, timeBlockWidthSec: 20, timeCoverageSec: 250, soleFirstPlaceCount: 40, sharedFirstPlaceRate: 0.15 });
        expect(wire.rankingMeasurement).not.to.have.property("eventRows");
        expect(wire.poolSnapshots).to.equal(undefined);
        expect(wire.candidateOutcomes).to.equal(undefined);
    });
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

    it("carries contributor-excluded summaries and exclusion counts by Finder arm", () => {
        const replayHorizon: Record<string, unknown> = {
            bars: 5,
            topMeanByAsset: [],
            armExTopContributorComparisons: {},
            armTopContributorAssets: {},
            armTopContributorEvents: {},
        };
        for (const [index, [, field]] of Object.entries(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).entries()) {
            (replayHorizon.armExTopContributorComparisons as Record<string, ReplayComparison>)[field] = comparison(index + 1);
            (replayHorizon.armTopContributorAssets as Record<string, string | null>)[field] = `ASSET${index}`;
            (replayHorizon.armTopContributorEvents as Record<string, number>)[field] = index + 2;
            (replayHorizon as Record<string, unknown>)[field] = comparison(index + 10);
        }
        const summaries = buildTopMeanHorizonSummaries({ horizons: [replayHorizon] } as unknown as OpenScoreUsdReplayResult);
        const summary = summaries[0]!;
        expect(summary.armComparisonsExTopContributor?.TOP_RAW?.events).to.equal(5);
        expect(summary.armTopContributors?.TOP_RAW).to.deep.equal({ asset: "ASSET4", events: 6 });
    });

	it("labels cooldown replay provenance separately from the raw current snapshot and annual resets", () => {
		const dom = { batchBacktestSp500TopMeanResults: { innerHTML: "" } };
		renderTopMeanResults(dom, {
			selectionCooldownBars: 5,
			horizons: [],
			annualReports: [{
				year: 2025,
				sampleFromSec: 1_735_689_600,
				sampleToSec: 1_767_225_599,
				horizons: [],
				reportLines: ["Selection cooldown: 5 target-asset bars; state reset at the start of this independent annual replay."],
			}],
		} as any, { latestArm: "TOP_MEAN", tieMode: "off" });

		expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("Selection cooldown: 5 target-asset bars per selector arm");
		expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("current snapshot uses raw scores");
		expect(dom.batchBacktestSp500TopMeanResults.innerHTML).to.include("state reset at the start of this independent annual replay");
	});
});
