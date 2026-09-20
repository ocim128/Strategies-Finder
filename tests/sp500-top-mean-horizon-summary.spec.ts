import { expect } from "chai";
import { describe, it } from "node:test";
import { buildTopMeanHorizonSummaries } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import type {
    OpenScoreUsdReplayResult,
    ReplayComparison,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";

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
    it("maps each Latest-picks arm name to its own comparison (no swaps)", () => {
        // events encodes the arm (1..5) so a swapped mapping cannot pass.
        const result = {
            horizons: [{
                bars: 24,
                topRaw: comparison(1),
                topMean: comparison(2),
                topMeanRawUnique: comparison(3),
                topRawProfitNow: comparison(4),
                topMeanProfitNow: comparison(5),
                topRawProfitNowConf: comparison(6),
                topMeanByAsset: [
                    { asset: "BBB", events: 2, share: 0.5, topMean: 0, randomMean: 0, delta: 0 },
                    { asset: "AAA", events: 2, share: 0.5, topMean: 0, randomMean: 0, delta: 0 },
                ],
            }],
        } as unknown as OpenScoreUsdReplayResult;

        const summaries = buildTopMeanHorizonSummaries(result);
        expect(summaries).to.have.lengthOf(1);
        const summary = summaries[0]!;
        expect(summary.horizon).to.equal(24);
        expect(summary.events).to.equal(2);
        expect(summary.latestArms!.TOP_RAW!.events).to.equal(1);
        expect(summary.latestArms!.TOP_MEAN!.events).to.equal(2);
        expect(summary.latestArms!.TOP_MEAN_RAW_UNIQUE!.events).to.equal(3);
        expect(summary.latestArms!.TOP_RAW_PROFIT_NOW!.events).to.equal(4);
        expect(summary.latestArms!.TOP_MEAN_PROFIT_NOW!.events).to.equal(5);
        expect(summary.latestArms!.TOP_RAW_PROFIT_NOW_CONF!.events).to.equal(6);
        // topAssets stays sorted by events desc, then asset name.
        expect(summary.topAssets.map((asset) => asset.asset)).to.deep.equal(["AAA", "BBB"]);
    });
});
