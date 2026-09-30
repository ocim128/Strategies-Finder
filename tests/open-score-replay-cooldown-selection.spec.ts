import { expect } from "chai";
import { describe, it } from "node:test";
import { aggregateHorizonResults } from "../lib/batch-backtest/open-score-replay/aggregation";
import { buildCandidateViews, selectAfterOutcomes } from "../lib/batch-backtest/open-score-replay/candidate-selection";
import type { Candidate, DecisionEvent, EventView, ProfitOnlyEvent } from "../lib/batch-backtest/open-score-replay/internal-types";
import { tieBreakDigest } from "../lib/batch-backtest/max-active-research-contract";

const ASSETS = ["AAA", "BBB", "CCC"];

function makeCandidate(assetIndex: number, raw = 1): Candidate {
    return { assetIndex, raw, adjusted: raw, mean: raw, activePairs: 1, z: raw };
}

function makeView(timeSec: number, assetIndexes: readonly number[], rawByAsset: readonly number[] = []): EventView {
    const candidates = assetIndexes.map((assetIndex) => makeCandidate(assetIndex, rawByAsset[assetIndex] ?? 1));
    return {
        timeSec,
        positives: candidates,
        profitPositives: candidates,
        profitNowPositives: candidates,
        profitNowConfidencePositives: candidates,
        topRaw: candidates[0]?.assetIndex ?? -1,
        topMean: candidates[0]?.assetIndex ?? -1,
        topMeanRawUnique: candidates[0]?.assetIndex ?? -1,
        topMeanRawUniquePool: candidates,
        topRawProfit: candidates[0]?.assetIndex ?? -1,
        topMeanProfit: candidates[0]?.assetIndex ?? -1,
        topRawProfitNow: candidates[0]?.assetIndex ?? -1,
        topMeanProfitNow: candidates[0]?.assetIndex ?? -1,
        topRawProfitNowConf: candidates[0]?.assetIndex ?? -1,
        topZ: candidates[0]?.assetIndex ?? -1,
        maxActivePairs: candidates.length,
        ties: { RAW: candidates.length > 1 ? 1 : 0, MEAN: candidates.length > 1 ? 1 : 0 },
    };
}

function boundaryMap(index: number): Map<number, number> {
    return new Map(ASSETS.map((_, assetIndex) => [assetIndex, index]));
}

function makeDecisionEvent(
    timeSec: number,
    rawScore: readonly number[],
    rawScoreProfitNow: readonly number[] = rawScore,
): DecisionEvent {
    const counts = (scores: readonly number[]) => Float64Array.from(scores, (score) => score > 0 ? 1 : 0);
    return {
        timeSec,
        rawScore: Float64Array.from(rawScore),
        activePairCount: counts(rawScore),
        rawScoreProfit: Float64Array.from(rawScore),
        activePairCountProfit: counts(rawScore),
        rawScoreProfitNow: Float64Array.from(rawScoreProfitNow),
        activePairCountProfitNow: counts(rawScoreProfitNow),
        rawScoreProfitNowConf: Float64Array.from(rawScoreProfitNow),
        activePairCountProfitNowConf: counts(rawScoreProfitNow),
    };
}

describe("OPEN_SCORE replay selection cooldown", () => {
    it("reuses ranked winners for asset-switch picks and stores null for tied extrema", async () => {
        const built = await buildCandidateViews({
            events: [
                makeDecisionEvent(100, [9, 6, 3], [1, 5, 4]),
                makeDecisionEvent(101, [9, 9, 3], [5, 5, 1]),
            ],
            totalEvents: 2,
            assetNames: ASSETS,
            assetCount: ASSETS.length,
            includeAllDecisionEvents: true,
            onPhase: () => undefined,
        });
        const first = built.views[0]!.assetSwitchPicks!;
        expect(first.topRaw).to.equal(built.views[0]!.topRaw);
        expect(first.topMean).to.equal(built.views[0]!.topMean);
        expect(first.topMeanRawUnique).to.equal(built.views[0]!.topMeanRawUnique);
        expect(first.topRawProfitNow).to.equal(1);
        expect(first.topMeanProfitNow).to.equal(1);
        expect(first.topRawProfitNowConf).to.equal(1);
        expect(first.topZ).to.equal(1);
        expect(first.botRaw).to.equal(2);
        expect(first.botMean).to.equal(2);
        expect(first.botMeanRawUnique).to.equal(2);
        expect(first.botRawProfitNow).to.equal(0);
        expect(first.botMeanProfitNow).to.equal(0);
        expect(first.botZ).to.equal(0);

        const tied = built.views[1]!.assetSwitchPicks!;
        expect(tied.topRaw).to.equal(null);
        expect(tied.topMean).to.equal(null);
        expect(tied.topMeanRawUnique).to.equal(null);
        expect(tied.topRawProfit).to.equal(null);
        expect(tied.topMeanProfit).to.equal(null);
        expect(tied.topRawProfitNow).to.equal(null);
        expect(tied.topMeanProfitNow).to.equal(null);
    });

    it("retains ordinary singleton events so their selected asset starts cooldown", async () => {
        const built = await buildCandidateViews({
            events: [makeDecisionEvent(100, [3, 0, 0]), makeDecisionEvent(101, [5, 4, 3])],
            totalEvents: 2,
            assetNames: ASSETS,
            assetCount: ASSETS.length,
            selectionCooldownBars: 1,
            onPhase: () => undefined,
        });
        expect(built.views).to.have.length(2);
        expect(built.views[0]!.positives).to.have.length(1);
        const selected = await selectAfterOutcomes({
            views: built.views,
            profitOnlyEvents: built.profitOnlyEvents,
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(100), boundaryMap(100)],
        });
        expect(selected.armSelectionsByView![0]!.topRaw!.selectedAssetIndex).to.equal(0);
        expect(selected.armSelectionsByView![1]!.topRaw!.selectedAssetIndex).to.not.equal(0);
    });

    it("retains singleton profit-only events for cooldown without adding ordinary views", async () => {
        const built = await buildCandidateViews({
            events: [
                makeDecisionEvent(100, [0, 0, 0], [3, 0, 0]),
                makeDecisionEvent(101, [5, 4, 3], [5, 4, 3]),
            ],
            totalEvents: 2,
            assetNames: ASSETS,
            assetCount: ASSETS.length,
            selectionCooldownBars: 1,
            onPhase: () => undefined,
        });
        expect(built.profitOnlyEvents).to.have.length(1);
        expect(built.profitOnlyEvents[0]!.profitNowPositives).to.have.length(1);
        const selected = await selectAfterOutcomes({
            views: built.views,
            profitOnlyEvents: built.profitOnlyEvents,
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(100), boundaryMap(100)],
        });
        const firstPick = selected.armSelectionsByProfitOnly![0]!.topRawProfitNow!.selectedAssetIndex;
        expect(firstPick).to.equal(0);
        expect(selected.armSelectionsByView![0]!.topRawProfitNow!.selectedAssetIndex).to.not.equal(0);
    });

    it("falls through tied ranks, selects a singleton, exhausts the pool, and allows expiry at X+1", async () => {
        const views = [10, 20, 30, 40].map((timeSec) => makeView(timeSec, [0, 1, 2]));
        const sameBar = await selectAfterOutcomes({
            views,
            profitOnlyEvents: [],
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: views.map(() => boundaryMap(100)),
        });
        const picks = sameBar.armSelectionsByView!.map((row) => row?.topRaw?.selectedAssetIndex ?? -1);
        expect(picks[0]).to.be.greaterThanOrEqual(0);
        expect(picks[1]).to.be.greaterThanOrEqual(0);
        expect(picks[1]).to.not.equal(picks[0]);
        expect(picks[2]).to.be.greaterThanOrEqual(0);
        expect(sameBar.armSelectionsByView![2]!.topRaw!.poolSize).to.equal(1);
        expect(picks[3]).to.equal(-1);

        const expiryViews = [makeView(10, [0, 1], [2, 1]), makeView(20, [0, 1], [2, 1])];
        const expiry = await selectAfterOutcomes({
            views: expiryViews,
            profitOnlyEvents: [],
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(100), boundaryMap(102)],
        });
        expect(expiry.armSelectionsByView![0]!.topRaw!.selectedAssetIndex).to.equal(0);
        expect(expiry.armSelectionsByView![1]!.topRaw!.selectedAssetIndex).to.equal(0);
    });

    it("carries arm cooldown through a profit-only event and preserves deterministic ties", async () => {
        const time0 = 10;
        const time1 = 20;
        const view = makeView(time0, [0, 1]);
        const profitOnly: ProfitOnlyEvent[] = [{
            timeSec: time1,
            profitPositives: [makeCandidate(0), makeCandidate(1), makeCandidate(2)],
            profitNowPositives: [makeCandidate(0), makeCandidate(1), makeCandidate(2)],
            profitNowConfidencePositives: [makeCandidate(0), makeCandidate(1), makeCandidate(2)],
        }];
        const result = await selectAfterOutcomes({
            views: [view],
            profitOnlyEvents: profitOnly,
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(5), boundaryMap(5)],
        });
        const firstPick = result.armSelectionsByView![0]!.topRawProfitNow!.selectedAssetIndex;
        const profitOnlyPick = result.armSelectionsByProfitOnly![0]!.topRawProfitNow!.selectedAssetIndex;
        const expectedFirst = [0, 1].sort((left, right) =>
            tieBreakDigest(time0, ASSETS[left]!) < tieBreakDigest(time0, ASSETS[right]!) ? -1 : 1,
        )[0]!;
        const expectedSecond = [0, 1, 2].filter((index) => index !== expectedFirst).sort((left, right) =>
            tieBreakDigest(time1, ASSETS[left]!) < tieBreakDigest(time1, ASSETS[right]!) ? -1 : 1,
        )[0]!;
        expect(firstPick).to.equal(expectedFirst);
        expect(profitOnlyPick).to.equal(expectedSecond);
        expect(profitOnlyPick).to.not.equal(firstPick);
    });

    it("keeps all selector arms isolated while each falls through its own ranked pool", async () => {
        const ranked = [
            { assetIndex: 0, raw: 3, adjusted: 3, mean: 1, activePairs: 1, z: 3 },
            { assetIndex: 1, raw: 2, adjusted: 2, mean: 2, activePairs: 1, z: 2 },
            { assetIndex: 2, raw: 1, adjusted: 1, mean: 3, activePairs: 1, z: 1 },
        ];
        const views = [makeView(10, [0, 1, 2]), makeView(20, [0, 1, 2])];
        for (const view of views) {
            view.positives = [...ranked];
            view.profitPositives = [...ranked];
            view.profitNowPositives = [...ranked];
            view.profitNowConfidencePositives = [...ranked];
        }
        const result = await selectAfterOutcomes({
            views,
            profitOnlyEvents: [],
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(100), boundaryMap(100)],
        });
        const first = result.armSelectionsByView![0]!;
        const second = result.armSelectionsByView![1]!;
        expect(Object.keys(first)).to.have.length(15);
        for (const selection of Object.values(first)) {
            expect(selection).to.not.have.property("pool");
            expect(selection).to.not.have.property("eligiblePool");
        }
        expect(first.topRaw?.selectedAssetIndex).to.equal(0);
        expect(first.topMean?.selectedAssetIndex).to.equal(2);
        expect(first.botRaw?.selectedAssetIndex).to.equal(2);
        expect(second.topRaw?.selectedAssetIndex).to.equal(1);
        expect(second.topMean?.selectedAssetIndex).to.equal(1);
        expect(second.botRaw?.selectedAssetIndex).to.equal(1);
        expect(second.topRaw?.poolSize).to.equal(2);
    });

    it("does not turn an unresolved unique-only tie into a cooldown selection", async () => {
        const tied = [0, 1].map((assetIndex) => ({
            assetIndex,
            raw: 1,
            adjusted: 1,
            mean: 1,
            activePairs: 1,
            z: 1,
        }));
        const views = [makeView(10, [0, 1]), makeView(20, [0, 1])];
        for (const view of views) {
            view.positives = [...tied];
            view.profitNowPositives = [...tied];
            view.profitNowConfidencePositives = [...tied];
        }
        const result = await selectAfterOutcomes({
            views,
            profitOnlyEvents: [],
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: [boundaryMap(4), boundaryMap(4)],
        });
        expect(result.armSelectionsByView![0]!.topMeanRawUnique?.selectedAssetIndex).to.equal(-1);
        expect(result.armSelectionsByView![1]!.topMeanRawUnique?.selectedAssetIndex).to.equal(-1);
        expect(result.armSelectionsByView![1]!.topMeanRawUnique?.tiedCount).to.equal(2);
    });

    it("keeps unique-arm comparisons when the full eligible pool has alternatives", async () => {
        const view = makeView(10, [0, 1, 2]);
        view.positives = [
            { ...makeCandidate(0, 9), mean: 3 },
            { ...makeCandidate(1, 4), mean: 2 },
            { ...makeCandidate(2, 2), mean: 1 },
        ];
        view.topRaw = 0;
        view.topMean = 0;
        view.topMeanRawUnique = 0;
        view.topMeanRawUniquePool = [view.positives[0]!];
        const boundaries = [boundaryMap(10)];
        const selection = await selectAfterOutcomes({
            views: [view],
            profitOnlyEvents: [],
            assetNames: ASSETS,
            dataGapAssets: new Map(),
            dataGapEvents: new Set(),
            selectionCooldownBars: 1,
            boundaryIndicesByView: boundaries,
        });
        expect(selection.armSelectionsByView![0]!.topMeanRawUnique?.poolSize).to.equal(1);
        expect(selection.armSelectionsByView![0]!.topMeanRawUnique?.eligiblePoolSize).to.equal(3);

        const outcomes = new Map(view.positives.map((candidate) => [candidate.assetIndex, {
            long: [candidate.assetIndex / 100],
            mtmLong: [candidate.assetIndex / 100],
            entryTime: 11,
            exitTimes: [12],
            statuses: ["ok" as const],
        }]));
        const aggregated = await aggregateHorizonResults({
            options: { horizons: [1], selectionCooldownBars: 1 },
            horizons: [1],
            blockCount: 1,
            bootstrapSamples: 0,
            views: [view],
            gapFilteredViews: selection.gapFilteredViews,
            gapFilteredProfitOnlyEvents: selection.gapFilteredProfitOnlyEvents,
            botPicksByView: selection.botPicksByView,
            armSelectionsByView: selection.armSelectionsByView,
            armSelectionsByProfitOnly: selection.armSelectionsByProfitOnly,
            boundaryIndicesByView: boundaries,
            returnsByView: [outcomes],
            dataGapAssets: new Map(),
            assetNames: ASSETS,
            retainedDegree: new Map(),
            noDataEvents: new Set(),
            onPhase: () => undefined,
        });
        expect(aggregated.horizonResults[0]!.topMeanRawUnique.events).to.equal(1);
    });
});
