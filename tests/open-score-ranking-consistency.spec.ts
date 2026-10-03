import { expect } from "chai";
import { describe, it } from "node:test";
import { captureRankingEvent, buildAssetSwitchDecisions, selectAfterOutcomes } from "../lib/batch-backtest/open-score-replay/candidate-selection";
import { aggregateRankingMeasurement, rankingPairCredit } from "../lib/batch-backtest/open-score-replay/aggregation";
import { blockBootstrapMeanCi, buildRankingTimeBlocks } from "../lib/batch-backtest/open-score-replay/statistics";
import { REPLAY_ARM_FIELDS } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { compactRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import type { Candidate, DecisionEvent, EventView, RankingEvent } from "../lib/batch-backtest/open-score-replay/internal-types";
import type { TargetOutcomeStageResult, ViewOutcomeRecord } from "../lib/batch-backtest/open-score-replay/target-outcomes";

const names = ["A", "B", "C", "D", "E", "F"];
const pool: Candidate[] = names.map((_, assetIndex) => ({ assetIndex, raw: 6 - assetIndex, mean: 6 - assetIndex, z: 6 - assetIndex, activePairs: 1, adjusted: 6 - assetIndex }));
function event(timeSec: number, candidates = pool): RankingEvent {
    return captureRankingEvent(timeSec, { positives: candidates, profitPositives: candidates, profitNowPositives: candidates, profitNowConfidencePositives: candidates }, names);
}
function outcomes(events: readonly RankingEvent[], returns = [5, 4, 3, 2, 1, 0], duration = 1): TargetOutcomeStageResult {
    return { returnsByView: events.map((event) => new Map(names.map((_, index) => [index, {
        long: [returns[index]!], mtmLong: [null], entryTime: event.timeSec + 1, exitTimes: [event.timeSec + duration], statuses: ["ok"],
    } satisfies ViewOutcomeRecord]))), missingAssets: new Set(), dataGapAssets: new Map(), dataGapEvents: new Set(), censoredEvents: new Set(), noDataEvents: new Set(), boundaryIndicesByView: [] };
}
async function measure(events: RankingEvent[], targets = outcomes(events), horizonBars = 1) {
    return aggregateRankingMeasurement({ events, outcomes: targets, horizonBars, interval: "1s", shouldStop: () => false });
}

describe("top-five ranking consistency", () => {
    it("freezes all 15 arm pools and direction, retaining only five assets", async () => {
        const row = event(0);
        expect(Object.keys(row.arms)).to.deep.equal(REPLAY_ARM_FIELDS);
        const summary = await measure([row]);
        for (const field of REPLAY_ARM_FIELDS) {
            expect(row.arms[field].picks).to.have.length(5);
            expect(summary.arms[field].meanAccuracy).to.equal(field.startsWith("bot") ? 0 : 1);
            expect(summary.arms[field].top1Superiority).to.equal(field.startsWith("bot") ? 0 : 1);
        }
        const distinctPools = captureRankingEvent(0, { positives: pool, profitPositives: pool.slice(1), profitNowPositives: pool.slice(2), profitNowConfidencePositives: [] }, names);
        expect(distinctPools.arms.topRaw.picks[0]!.assetIndex).to.equal(0);
        expect(distinctPools.arms.topRawProfit.picks[0]!.assetIndex).to.equal(1);
        expect(distinctPools.arms.topZ.reason).to.equal("small_pool");
        expect(distinctPools.arms.topRawProfitNowConf.picks).to.have.length(0);
    });

    it("gives neutral predictor/return ties and uses the complete mean/raw key", async () => {
        const tied = pool.map((row) => ({ ...row, raw: 1, mean: 1, z: 1 }));
        const row = event(0, tied);
        expect(row.arms.topMeanRawUnique.reason).to.equal("unresolved_pick");
        expect(row.arms.botMeanRawUnique.reason).to.equal("unresolved_pick");
        const result = await measure([row]);
        expect(result.arms.topRaw.meanAccuracy).to.equal(0.5);
        expect(result.arms.topRaw.tiedComparisons).to.equal(10);
        const refined = event(0, pool.map((row) => ({ ...row, mean: 1 })));
        expect((await measure([refined])).arms.topMeanRawUnique.meanAccuracy).to.equal(1);
        expect((await measure([refined])).arms.topMean.meanAccuracy).to.equal(0.5);
        const first = row.arms.topRaw.picks[0]!, second = row.arms.topRaw.picks[1]!;
        expect(rankingPairCredit(first, second, -100, 10000)).to.equal(0.5);
        expect(rankingPairCredit({ ...first, key: 9 }, second, 1, 1)).to.equal(0.5);
    });

    it("separates sole and shared first places using the same scored events", async () => {
        const events = [event(0), event(10), event(20)];
        const targets = outcomes(events);
        targets.returnsByView[1] = outcomes([events[1]!], [5, 5, 1, 0, -1, -2]).returnsByView[0]!;
        targets.returnsByView[2] = outcomes([events[2]!], [0, 5, 4, 3, 2, 1]).returnsByView[0]!;
        const summary = (await measure(events, targets)).arms.topRaw;
        expect(summary).to.include({ scoredEvents: 3, soleFirstPlaceCount: 1, sharedFirstPlaceCount: 1,
            soleFirstPlaceRate: 1 / 3, sharedFirstPlaceRate: 1 / 3, top1Superiority: 0.625 });
        const allTied = (await measure([event(0)], outcomes([event(0)], [1, 1, 1, 1, 1, 1]))).arms.topRaw;
        expect(allTied).to.include({ soleFirstPlaceCount: 0, sharedFirstPlaceCount: 1, soleFirstPlaceRate: 0, sharedFirstPlaceRate: 1, top1Superiority: 0.5 });
        const empty = (await measure([])).arms.topRaw;
        expect(empty).to.include({ soleFirstPlaceCount: 0, sharedFirstPlaceCount: 0, soleFirstPlaceRate: null, sharedFirstPlaceRate: null });
    });

    it("records actual selected-asset first places despite tied predictor scores", async () => {
        const row = event(0, pool.map((candidate) => ({ ...candidate, raw: 1, mean: 1, z: 1 })));
        const winner = row.arms.topRaw.picks[0]!.assetIndex;
        const returns = names.map((_, index) => index === winner ? 100 : 0);
        const summary = (await measure([row], outcomes([row], returns))).arms.topRaw;
        expect(summary).to.include({ soleFirstPlaceCount: 1, sharedFirstPlaceCount: 0,
            soleFirstPlaceRate: 1, sharedFirstPlaceRate: 0, top1Superiority: 0.5, meanAccuracy: 0.5 });
    });

    it("preserves legacy v2 scores and validates additive count/rate consistency independently", async () => {
        const measured = await measure([event(0)]);
        const original = structuredClone(measured);
        const legacy = original.arms.topRaw;
        delete legacy.soleFirstPlaceCount; delete legacy.sharedFirstPlaceCount;
        delete legacy.soleFirstPlaceRate; delete legacy.sharedFirstPlaceRate;
        const compact = compactRankingMeasurement(original)!;
        expect(compact.semanticsVersion).to.equal(measured.semanticsVersion);
        expect(compact.arms.topRaw).to.deep.equal(legacy);
        expect(compact.arms.topRaw).not.to.have.property("soleFirstPlaceCount");
        expect(compactRankingMeasurement(measured)).to.deep.equal(measured);
        for (const bad of [
            { soleFirstPlaceCount: 2, sharedFirstPlaceCount: 0 },
            { soleFirstPlaceCount: 1, sharedFirstPlaceCount: 1 },
            { soleFirstPlaceCount: -1, sharedFirstPlaceCount: 0 },
            { soleFirstPlaceRate: 0.5 },
            { sharedFirstPlaceRate: NaN },
        ]) {
            const changed = structuredClone(measured);
            Object.assign(changed.arms.topRaw, bad);
            const restored = compactRankingMeasurement(changed)!;
            expect(restored.arms.topRaw.meanAccuracy).to.equal(measured.arms.topRaw.meanAccuracy);
            expect(restored.arms.topRaw).not.to.have.property("soleFirstPlaceCount");
        }
        const fromCounts = structuredClone(measured);
        delete fromCounts.arms.topRaw.soleFirstPlaceRate; delete fromCounts.arms.topRaw.sharedFirstPlaceRate;
        expect(compactRankingMeasurement(fromCounts)?.arms.topRaw.soleFirstPlaceRate).to.equal(1);
    });

    it("weights events equally and ignores return magnitude after pair credit", async () => {
        const events = [event(0), event(10)];
        const targets = outcomes(events);
        targets.returnsByView[1] = outcomes([events[1]!], [0, 1, 2, 3, 4, 100000]).returnsByView[0]!;
        const result = await measure(events, targets);
        expect(result.arms.topRaw.meanAccuracy).to.equal(0.5);
        expect(result.arms.topRaw.top1Superiority).to.equal(0.5);
        const mixed = await measure([event(0)], outcomes([event(0)], [5, 3, 4, 2, 1, 0]));
        expect(mixed.arms.topRaw.meanAccuracy).to.equal(0.9);
        expect(mixed.arms.topRaw.top1Superiority).to.equal(1);
    });

    it("includes every valid overlapping event in both equal-event means", async () => {
        const events = [event(10), event(0), event(2), event(3)];
        const targets = outcomes(events, undefined, 20);
        targets.returnsByView[2] = outcomes([events[2]!], [0, 1, 2, 3, 4, 100000], 20).returnsByView[0]!;
        const summary = (await measure(events, targets, 20)).arms.topRaw;
        expect(summary.eligibleEvents).to.equal(4);
        expect(summary.scoredEvents).to.equal(4);
        expect(summary.meanAccuracy).to.equal(0.75);
        expect(summary.top1Superiority).to.equal(0.75);
        expect(summary.comparisons).to.equal(40);
        expect(summary).not.to.have.property("overlapSkippedEvents");
        // 238 separated cohorts, each with five or six overlapping valid events.
        // The former spacing rule would retain only one event per cohort.
        const all = Array.from({ length: 238 }, (_, group) => Array.from({ length: group < 146 ? 6 : 5 }, (_, offset) => event(group * 100 + offset))).flat();
        expect(all).to.have.length(1336);
        expect((await measure(all, outcomes(all, undefined, 12), 12)).arms.topRaw.scoredEvents).to.equal(1336);
    });

    it("keeps nearby overlapping cohorts together in elapsed-time bins with irregular spacing", () => {
        const entries = [0, 1, 4, 100, 101, 400];
        const windows = entries.map((entryTime) => ({ entryTime, exitTime: entryTime + 10 }));
        const result = buildRankingTimeBlocks(entries, windows, 11, "1s");
        expect(result.measurementWindowSec).to.equal(11);
        expect(result.timeBlockWidthSec).to.equal(22);
        expect(result.blocks).to.deep.equal([[0, 1, 4], [100, 101], [400]]);
        expect(result.timeCoverageSec).to.equal(411);
        // A boundary belongs to the next bin. Empty calendar bins add no coverage count.
        expect(buildRankingTimeBlocks([1, 2, 3], [0, 21, 22].map((entryTime) => ({ entryTime, exitTime: entryTime + 10 })), 11, "1s").blocks).to.deep.equal([[1, 2], [3]]);
    });

    it("derives widths from calendar time including closures and handles one-bar horizons explicitly", () => {
        const day = 86400;
        const windows = [{ entryTime: 0, exitTime: 4 * 3600 }, { entryTime: day, exitTime: 4 * day }];
        const result = buildRankingTimeBlocks([0, 1], windows, 2, "4h");
        expect(result.measurementWindowSec).to.equal(3 * day + 4 * 3600);
        expect(result.timeBlockWidthSec).to.equal(2 * (3 * day + 4 * 3600));
        expect(result.blocks).to.deep.equal([[0, 1]]);
        const oneBar = [0, 30, 119, 120].map((entryTime) => ({ entryTime, exitTime: entryTime }));
        expect(buildRankingTimeBlocks([1, 2, 3, 4], oneBar, 1, "1m")).to.include({ measurementWindowSec: 60, timeBlockWidthSec: 120, timeCoverageSec: 180 });
        expect(buildRankingTimeBlocks([1, 2, 3, 4], oneBar, 1, "1m").blocks).to.deep.equal([[1, 2, 3], [4]]);
        expect(buildRankingTimeBlocks([1], [oneBar[0]!], 1).blocks).to.deep.equal([]);
        expect(buildRankingTimeBlocks([1], [{ entryTime: 0, exitTime: 30 }], 4).measurementWindowSec).to.equal(40);
    });

    it("requires populated time coverage as well as 100 scored events and retains unavailable means", async () => {
        const dense = Array.from({ length: 100 }, (_, i) => event(i / 100));
        const summary = (await measure(dense)).arms.topRaw;
        expect(summary).to.include({ scoredEvents: 100, meanAccuracy: 1, blockCount: 1, status: "insufficient_data", ciLower: null, ciUpper: null });
        expect(compactRankingMeasurement(await measure(dense))).not.to.equal(undefined);
        const unknownOneBar = await aggregateRankingMeasurement({ events: dense, outcomes: outcomes(dense), horizonBars: 1, shouldStop: () => false });
        expect(unknownOneBar.arms.topRaw).to.include({ meanAccuracy: 1, blockCount: 0, timeBlockWidthSec: null, ciLower: null });
        const cohorts = Array.from({ length: 100 }, (_, i) => event(Math.floor(i / 10) * 100 + i % 10));
        expect((await measure(cohorts, outcomes(cohorts, undefined, 20), 20)).arms.topRaw).to.include({ blockCount: 10, status: "available" });
        const nineCohorts = cohorts.map((_, i) => event(Math.floor(i / 12) * 100 + i % 12));
        expect((await measure(nineCohorts, outcomes(nineCohorts, undefined, 20), 20)).arms.topRaw).to.include({ scoredEvents: 100, blockCount: 9, status: "insufficient_data", ciLower: null });
    });

    it("supports longer block widths including twice the initial width without event reweighting", async () => {
        const values = Array.from({ length: 120 }, (_, i) => i < 20 ? 0 : 1);
        const windows = values.map((_, i) => ({ entryTime: i * 10, exitTime: i * 10 + 9 }));
        const initial = buildRankingTimeBlocks(values, windows, 10, "1s");
        for (const multiplier of [1.5, 2, 3]) {
            const wider = buildRankingTimeBlocks(values, windows, 10, "1s", multiplier);
            expect(wider.timeBlockWidthSec).to.equal(initial.timeBlockWidthSec! * multiplier);
            expect(wider.blocks.flat()).to.deep.equal(values);
            expect(wider.blocks.length).to.be.lessThan(initial.blocks.length);
            expect(await blockBootstrapMeanCi(wider.blocks)).to.deep.equal(await blockBootstrapMeanCi(wider.blocks));
            const pooled = wider.blocks.flat();
            expect(pooled.reduce((sum, value) => sum + value, 0) / pooled.length).to.equal(100 / 120);
        }
    });

    it("requires 100 scored events for repeatable mean confidence bounds", async () => {
        const events = Array.from({ length: 100 }, (_, index) => event(index * 10));
        const insufficient = (await measure(events.slice(0, 99))).arms.topRaw;
        expect(insufficient.status).to.equal("insufficient_data");
        expect(insufficient.meanAccuracy).to.equal(1);
        expect(insufficient.ciLower).to.equal(null);
        const enough = await measure(events);
        expect(enough.arms.topRaw).to.include({ status: "available", blockCount: 100, ciLower: 1, ciUpper: 1 });
        expect(await measure(events)).to.deep.equal(enough);
        expect(compactRankingMeasurement(enough)).to.deep.equal(enough);
        const values = Array.from({ length: 103 }, (_, i) => i / 103);
        const windows = values.map((_, i) => ({ entryTime: i < 90 ? Math.floor(i / 10) * 100 + i % 10 : 900 + (i - 90), exitTime: (i < 90 ? Math.floor(i / 10) * 100 + i % 10 : 900 + (i - 90)) + 19 }));
        const blocks = buildRankingTimeBlocks(values, windows, 20, "1s").blocks;
        // Independent pooled-sample reference, including unequal block lengths.
        let seed = 20260301; // replaced with canonical seed below
        const canonical = await import("../lib/batch-backtest/max-active-research-contract");
        seed = (Math.floor(canonical.MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
        const means = Array.from({ length: 10_000 }, () => {
            const pooled: number[] = [];
            for (let i = 0; i < 10; i += 1) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                pooled.push(...blocks[Math.floor(seed / 0x100000000 * 10)]!);
            }
            return pooled.reduce((sum, n) => sum + n, 0) / pooled.length;
        }).sort((a, b) => a - b);
        const ci = await blockBootstrapMeanCi(blocks);
        expect(ci.lower).to.be.closeTo(means[250]!, 1e-14);
        expect(ci.upper).to.be.closeTo(means[9750]!, 1e-14);
    });

    it("omits the complete five on missing, invalid, gapped, censored or misaligned targets without backfill", async () => {
        for (const failure of ["missing_target", "missing_entry", "data_gap", "right_censored", "invalid_price", "calendar_mismatch"] as const) {
            const events = [event(0)];
            const target = outcomes(events);
            const member = target.returnsByView[0]!.get(1)!;
            if (failure === "missing_target") { target.missingAssets.add(1); target.returnsByView[0]!.delete(1); }
            else if (failure === "missing_entry") target.returnsByView[0]!.delete(1);
            else if (failure === "data_gap") target.dataGapAssets.set(1, {} as never);
            else if (failure === "calendar_mismatch") member.exitTimes[0] = 20;
            else member.statuses[0] = failure;
            const result = (await measure(events, target)).arms.topRaw;
            expect(result.status).to.equal("no_events");
            expect(result.skippedReasons[failure]).to.equal(1);
            expect(events[0]!.arms.topRaw.picks.map((pick) => pick.assetIndex)).not.to.include(5);
        }
        expect((await measure([event(0, pool.slice(0, 3))])).arms.topRaw.skippedReasons.small_pool).to.equal(1);
        expect((await measure([])).arms.topRaw.meanAccuracy).to.equal(null);
    });

    it("captures switch records before release without changing decisions or selected assets", async () => {
        const snapshots: DecisionEvent[] = [0, 10].map((timeSec) => ({ timeSec,
            rawScore: Float64Array.from([6, 5, 4, 3, 2, 1]), activePairCount: Float64Array.from([1, 1, 1, 1, 1, 1]),
            rawScoreProfit: Float64Array.from([6, 5, 4, 3, 2, 1]), activePairCountProfit: Float64Array.from([1, 1, 1, 1, 1, 1]),
            rawScoreProfitNow: Float64Array.from([6, 5, 4, 3, 2, 1]), activePairCountProfitNow: Float64Array.from([1, 1, 1, 1, 1, 1]),
            rawScoreProfitNowConf: Float64Array.from([6, 5, 4, 3, 2, 1]), activePairCountProfitNowConf: Float64Array.from([1, 1, 1, 1, 1, 1]),
        }));
        const args = { events: snapshots, totalEvents: 2, assetCount: 6, assetNames: names, onPhase() {} };
        const off = await buildAssetSwitchDecisions(args);
        const future = { ...snapshots[1]!, timeSec: 20, rawScore: Float64Array.from([1, 20, 2, 30, 3, 40]) };
        const extended = await buildAssetSwitchDecisions({ ...args, events: [...snapshots, future], totalEvents: 3, captureRanking: true });
        const on = await buildAssetSwitchDecisions({ ...args, captureRanking: true, onEventProcessed(index) { snapshots[index] = null as unknown as DecisionEvent; } });
        if (!off.ok || !on.ok || !extended.ok) throw new Error("stage failed");
        expect(extended.result.rankingEvents!.slice(0, 2)).to.deep.equal(on.result.rankingEvents);
        expect(on.result.decisions).to.deep.equal(off.result.decisions);
        expect(on.result.selectedAssets).to.deep.equal(off.result.selectedAssets);
        expect(on.result.rankingEvents).to.have.length(2);
        expect(snapshots).to.deep.equal([null, null]);
        for (const record of on.result.rankingEvents!) for (const field of REPLAY_ARM_FIELDS) expect(record.arms[field].picks.length).to.be.at.most(5);
        expect(on.result.rankingEvents![0]!.arms.topZ.picks[0]!.key).to.equal(6);
        expect(on.result.rankingEvents![1]!.arms.topZ.picks.every((pick) => pick.key === 0)).to.equal(true);
    });

    it("uses existing pre-update cooldown history and freezes the original pool before gaps", async () => {
        const views: EventView[] = [0, 1, 2].map((timeSec) => ({ timeSec, positives: pool, profitPositives: pool, profitNowPositives: pool, profitNowConfidencePositives: pool,
            topRaw: 0, topMean: 0, topMeanRawUnique: 0, topMeanRawUniquePool: [pool[0]!], topRawProfit: 0, topMeanProfit: 0, topRawProfitNow: 0, topMeanProfitNow: 0, topRawProfitNowConf: 0, topZ: 0, maxActivePairs: 1, ties: { RAW: 0, MEAN: 0 } }));
        const captured: Array<{ time: number; assets: number[]; effective: number }> = [];
        await selectAfterOutcomes({ views, profitOnlyEvents: [], assetNames: names, dataGapAssets: new Map([[0, {}]]), dataGapEvents: new Set(), selectionCooldownBars: 1,
            boundaryIndicesByView: views.map((_, i) => new Map(names.map((_, a) => [a, i]))),
            onRankingSelection(time, field, original, effective) { if (field === "topRaw") captured.push({ time, assets: original.map((row) => row.assetIndex), effective }); } });
        expect(captured[0]).to.deep.equal({ time: 0, assets: [0, 1, 2, 3, 4, 5], effective: 1 });
        expect(captured[1]!.assets).not.to.include(1);
        expect(captured[1]!.assets).to.include(0);
        expect(captured[2]!.assets).to.include(1);
    });

    it("yields during confidence draws so Stop cancels the bootstrap", async () => {
        const blocks = Array.from({ length: 20 }, (_, i) => Array.from({ length: 10 }, () => i / 20));
        let stopped = false;
        setImmediate(() => { stopped = true; });
        let error: unknown;
        try { await blockBootstrapMeanCi(blocks, 10_000, () => stopped); } catch (caught) { error = caught; }
        expect(String(error)).to.contain("cancelled during ranking measurement");
    });

    it("Stop aborts measurement instead of returning partial scores", async () => {
        let error: unknown;
        try { await aggregateRankingMeasurement({ events: [event(0)], outcomes: outcomes([event(0)]), horizonBars: 1, interval: "1s", shouldStop: () => true }); } catch (caught) { error = caught; }
        expect(String(error)).to.contain("cancelled during ranking measurement");
    });
});
