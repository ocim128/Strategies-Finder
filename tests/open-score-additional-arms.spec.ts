import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanArtifacts } from "../lib/batch-backtest/open-score-replay/artifact-scan";
import { sweepScoreEvents } from "../lib/batch-backtest/open-score-replay/event-sweep";
import { TemporalSupport } from "../lib/batch-backtest/open-score-replay/temporal-support";
import { runOpenScoreUsdReplay } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { toBatchSyntheticPairAdapter, type CompactPairArtifact, type CompactTrade } from "../lib/batch-backtest/compact-pair-artifact";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { OHLCVData } from "../lib/types/strategies";
import { CAUSAL_ARM_FIELDS, LEGACY_REPLAY_ARM_FIELDS, REPLAY_ARM_FIELDS } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { buildAssetSwitchDecisions, buildCandidateViews, captureRankingEvent, selectAfterOutcomes } from "../lib/batch-backtest/open-score-replay/candidate-selection";
import { createEmptyRankingMeasurement, compactRankingMeasurement, compactCausalArmDiagnostics } from "../lib/batch-backtest/open-score-replay/types";
import { compactCausalArmDefinitions, FINDER_SUPPORT_ARMS_V2 } from "../lib/batch-backtest/open-score-replay/causal-arm-constants";

const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const trade = (entryTime: number, exitTime: number, type: "long" | "short" = "long", open = false): CompactTrade => ({ entryTime: entryTime as CompactTrade["entryTime"], exitTime: exitTime as CompactTrade["exitTime"], type, pnl: 1, exitReason: open ? "end_of_data" : "signal" });
const pair = (baseAsset: string, quoteAsset: string, trades: CompactTrade[], pairIndex = 0): BatchSyntheticPairArtifact => toBatchSyntheticPairAdapter({ schema: "compact_pair_artifact.v1", pairIndex, baseAsset, quoteAsset, baseSymbol: baseAsset, quoteSymbol: quoteAsset, symbol: `${baseAsset}/${quoteAsset}`, trades, netProfit: 1 } as CompactPairArtifact) as unknown as BatchSyntheticPairArtifact;
const source = (pairs: BatchSyntheticPairArtifact[]) => () => (async function* () { yield* pairs; })();
const candles = (count = 90): OHLCVData[] => Array.from({ length: count }, (_, i) => ({ time: i * 60 as OHLCVData["time"], open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i, volume: 1 }));
const scan = (pairs: BatchSyntheticPairArtifact[], enabled = true) => scanArtifacts({ artifactLoader: source(pairs), shouldStop: () => false, onPhase() {}, capTiltWeight: null, lookupMarketCap: null, capTiltActive: false, sampleFromSec: undefined, sampleToSec: undefined, enableCausalArms: enabled });

describe("Finder temporal support arms", () => {
    it("retains exactly seventeen arms and safely projects historical five-arm provenance", () => {
        assert.deepEqual(CAUSAL_ARM_FIELDS, ["topStableSupport", "topFreshSupport"]);
        assert.equal(REPLAY_ARM_FIELDS.length, 17);
        const legacy = { ...FINDER_SUPPORT_ARMS_V2, version: "finder-causal-arms-v1", priceReturns: 24, graphMaxIterations: 500 };
        assert.deepEqual(compactCausalArmDefinitions(legacy), { ...FINDER_SUPPORT_ARMS_V2, version: "finder-causal-arms-v1" });
        assert.deepEqual(compactCausalArmDiagnostics({ eligibleCandidates: { topStableSupport: 2, topFreshSupport: 3, topCoverage: 9 },
            unavailableDegree: 0, unavailableSupportHistory: 1, graphSolverFailures: 5 }),
        { eligibleCandidates: { topStableSupport: 2, topFreshSupport: 3 }, unavailableDegree: 0, unavailableSupportHistory: 1 });
    });

    it("keeps causal support picks unchanged after forward target gaps are discovered", async () => {
        const pairs = [pair("B", "Q", [trade(0, 9999, "long", true)]), pair("A", "Q", [trade(1500, 9999, "long", true), trade(1500, 9999, "long", true)])];
        const scanned = await scan(pairs); assert.ok(scanned.ok); const s = scanned.result;
        const swept = await sweepScoreEvents({ ...s, interval: "1m", enableCausalArms: true, sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length }); assert.ok(swept.ok);
        const stage = await buildCandidateViews({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, onPhase() {} }); assert.ok(stage.ok);
        const view = stage.result.views[0]!;
        const after = await selectAfterOutcomes({ views: stage.result.views, profitOnlyEvents: [], assetNames: s.assetNames, enableCausalArms: true,
            dataGapAssets: new Map([[view.causalPicks!.topStableSupport!, true]]), dataGapEvents: new Set() });
        assert.equal(after.latestSelections!.selections.find((row) => row.selector === "TOP_STABLE_SUPPORT")!.asset, "B");
        assert.equal(after.latestSelections!.selections.find((row) => row.selector === "TOP_FRESH_SUPPORT")!.asset, "A");
    });
    it("freezes valid loaded degree independently of trades and legacy retained degree", async () => {
        const result = await scan([pair("A", "Q", [trade(0, 600)]), pair("A", "R", []), pair("A", "A", []), pair("", "Q", []), pair("B", "Q", [trade(0, 9999, "short", true)])]);
        assert.ok(result.ok);
        assert.equal(result.result.validDegree!.get("A"), 2);
        assert.equal(result.result.retainedDegree.get("A"), 3);
        assert.equal(result.result.validDegree!.get("Q"), 2);
        assert.equal("pairEndpoints" in result.result, false);
        assert.deepEqual([...result.result.streams[0]!.entrySecs!], [0, 0, 0, 0]);
        const disabled = await scan([pair("A", "Q", [trade(0, 600)])], false);
        assert.ok(disabled.ok); assert.equal(disabled.result.validDegree, undefined); assert.equal(disabled.result.streams[0]!.entrySecs, undefined);
    });

    it("integrates exit-only changes and pre-window history; expiry does not double-remove exits", async () => {
        const result = await scan([pair("A", "Q", [trade(0, 600), trade(1500, 9999, "long", true)]), pair("B", "Q", [trade(0, 9999, "long", true)]), pair("A", "R", [])]);
        assert.ok(result.ok); const s = result.result;
        const swept = await sweepScoreEvents({ ...s, enableCausalArms: true, interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length });
        assert.ok(swept.ok); assert.equal(swept.result.events.length, 1);
        const event = swept.result.events[0]!, a = s.assetIndexByName.get("A")!, b = s.assetIndexByName.get("B")!;
        near(event.causalScores!.get(a)!.topStableSupport, 540 / 1440 / 2);
        near(event.causalScores!.get(a)!.topFreshSupport, 0.5);
        near(event.causalScores!.get(b)!.topFreshSupport, 0);
        const support = new TemporalSupport(24, 0);
        support.advance(0); support.update(0, 0, 0, 2, true, 2); support.update(0, 0, 0, -1, true, 1);
        support.advance(12); support.update(0, 12, 0, -2, false, -1);
        near(support.scores(0, 12, 1).fresh, -0.5);
        support.advance(24); near(support.scores(0, 24, 1).fresh, 0);
        support.advance(25); support.update(0, 25, 0, 1, false, 0); near(support.scores(0, 25, 1).fresh, 0);
        near(support.scores(0, 25, 1).stable, -2 / 24);
    });

    it("loads only targets requested by retained switch arms", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(1500, 9999, "long", true)]));
        const reads = new Map<string, number>();
        const result = await runOpenScoreUsdReplay(source(pairs), undefined, {
            enableCausalArms: true, mode: "asset_switch", interval: "1m", sampleFromSec: 1500, sampleToSec: 1700,
            evaluationCutoffSec: 5000, loadTargetDataset: async (asset) => {
                reads.set(asset, (reads.get(asset) ?? 0) + 1);
                return candles();
            },
        });
        assert.ok(reads.size < 6, "support scoring must not load the whole positive universe");
        assert.ok([...reads.values()].every((count) => count === 1));
        assert.equal(result.assetSwitch!.coverage.requestedAssets, reads.size);
        assert.equal(result.assetSwitch!.coverage.loadedAssets, result.assetSwitch!.coverage.requestedAssets);
    });

    for (const mode of ["horizon", "asset_switch"] as const) for (const ranking of [false, true]) {
        it(`keeps all 15 legacy results identical with causal scoring enabled: ${mode}, ranking=${ranking}`, async () => {
            const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), trade(1500, 9999, "long", true)]));
            const options = { mode, horizons: [2], interval: "1m", sampleFromSec: 1500, sampleToSec: 1700, evaluationCutoffSec: 5000, loadTargetDataset: async () => candles(), ...(ranking ? { rankingHorizon: 2 } : {}) };
            const legacy = await runOpenScoreUsdReplay(source(pairs), undefined, options);
            const enabled = await runOpenScoreUsdReplay(source(pairs), undefined, { ...options, enableCausalArms: true });
            for (const field of LEGACY_REPLAY_ARM_FIELDS) {
                assert.deepEqual(enabled.assetSwitch?.arms[field], legacy.assetSwitch?.arms[field], field);
                assert.deepEqual(enabled.horizons[0]?.[field], legacy.horizons[0]?.[field], field);
                assert.deepEqual(enabled.rankingMeasurement?.arms[field], legacy.rankingMeasurement?.arms[field], field);
            }
            for (const field of CAUSAL_ARM_FIELDS) {
                assert.ok(mode === "horizon" ? enabled.horizons[0]![field] : enabled.assetSwitch!.arms[field]);
                if (ranking) assert.equal(enabled.rankingMeasurement!.arms[field]!.scoredEvents, 1);
            }
            assert.equal(enabled.causalArmDefinitions!.version, "finder-causal-arms-v2");
            assert.equal(enabled.causalArmDiagnostics!.eligibleCandidates.topStableSupport, 6);
        });
    }

    it("preserves old 15-arm ranking data without manufacturing new summaries; validates additions independently", () => {
        const legacy = createEmptyRankingMeasurement(5);
        const compact = compactRankingMeasurement(legacy)!;
        assert.deepEqual(compact, legacy);
        assert.equal(compact.arms.topFreshSupport, undefined);
        const enabled = createEmptyRankingMeasurement(5, true);
        assert.deepEqual(compactRankingMeasurement(enabled), enabled);
        enabled.arms.topStableSupport!.scoredEvents = -1;
        const recovered = compactRankingMeasurement(enabled)!;
        assert.deepEqual(recovered.arms.topRaw, legacy.arms.topRaw); assert.equal(recovered.arms.topStableSupport, undefined);
    });

    it("freezes score keys, top-five membership and picks before forward inspection in both modes", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), trade(1500, 9999, "long", true)]));
        const result = await scan(pairs); assert.ok(result.ok); const s = result.result;
        const swept = await sweepScoreEvents({ ...s, enableCausalArms: true, interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length }); assert.ok(swept.ok);
        for (const keys of swept.result.events[0]!.causalScores!.values()) keys.topStableSupport = -10;
        const views = await buildCandidateViews({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, onPhase() {} }); assert.ok(views.ok);
        const ranking = captureRankingEvent(1500, views.result.views[0]!, s.assetNames, true);
        assert.equal(ranking.arms.topStableSupport.picks.length, 5); assert.equal(ranking.arms.topStableSupport.picks[0]!.key, -10);
        assert.equal(ranking.arms.topStableSupport.reason, undefined);
        const compactResult = await scan(pairs); assert.ok(compactResult.ok); const cs = compactResult.result;
        const compactSweep = await sweepScoreEvents({ ...cs, enableCausalArms: true, mode: "asset_switch", interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: cs.assetNames.length }); assert.ok(compactSweep.ok);
        assert.equal(compactSweep.result.events[0]!.causalScores, undefined);
        const switches = await buildAssetSwitchDecisions({ events: compactSweep.result.events, totalEvents: 1, totalPairs: cs.pairCount, assetNames: cs.assetNames, assetCount: cs.assetNames.length, enableCausalArms: true, captureRanking: true, onPhase() {} }); assert.ok(switches.ok);
        assert.equal(switches.result.decisions[0]!.eligiblePoolCounts!.topFreshSupport, 6);
        assert.ok(switches.result.rankingEvents![0]!.arms.topStableSupport.picks.length <= 5);
    });

    it("preserves legacy cooldown histories and produces contributor exclusions for all new arms", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), ...[1500, 1560, 1620, 1680, 1740].map((t) => trade(t, 9999, "long", true))]));
        const options = { horizons: [2], rankingHorizon: 2, interval: "1m", sampleFromSec: 1500, sampleToSec: 1800, evaluationCutoffSec: 5000, selectionCooldownBars: 1, loadTargetDataset: async () => candles() };
        const legacy = await runOpenScoreUsdReplay(source(pairs), undefined, options);
        const enabled = await runOpenScoreUsdReplay(source(pairs), undefined, { ...options, enableCausalArms: true });
        for (const field of LEGACY_REPLAY_ARM_FIELDS) {
            assert.deepEqual(enabled.horizons[0]![field], legacy.horizons[0]![field]);
            assert.deepEqual(enabled.rankingMeasurement!.arms[field], legacy.rankingMeasurement!.arms[field]);
        }
        for (const field of CAUSAL_ARM_FIELDS) {
            assert.ok(enabled.horizons[0]![field]!.events > 0);
            assert.equal(enabled.horizons[0]!.armExTopContributorComparisons![field]!.events,
                enabled.horizons[0]![field]!.events - enabled.horizons[0]!.armTopContributorEvents![field]!);
        }
    });

    it("calculates real zero-event sections for enabled runs without trade deltas", async () => {
        const result = await runOpenScoreUsdReplay(source([pair("A", "Q", [])]), undefined,
            { enableCausalArms: true, horizons: [2], rankingHorizon: 2, interval: "1m", loadTargetDataset: async () => { throw new Error("must not load targets"); } });
        for (const field of CAUSAL_ARM_FIELDS) { assert.equal(result.horizons[0]![field]!.events, 0); assert.equal(result.rankingMeasurement!.arms[field]!.scoredEvents, 0); }
        assert.equal(result.causalArmDefinitions!.version, "finder-causal-arms-v2");
    });

    it("attributes ranking work to aggregation in both replay modes with bounded arm progress", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(1500, 9999, "long", true)]));
        for (const mode of ["horizon", "asset_switch"] as const) {
            const progress: Array<{ phase: string; detail: string; completed: number; total: number }> = [];
            const options = { mode, horizons: [2], rankingHorizon: 2, interval: "1m", sampleFromSec: 1500, sampleToSec: 1800,
                evaluationCutoffSec: 5000, enableCausalArms: true, loadTargetDataset: async () => candles() };
            const measured = await runOpenScoreUsdReplay(source(pairs), undefined, { ...options,
                onPhase(phase, detail, completed, total) { progress.push({ phase, detail, completed, total }); } });
            const rankingProgress = progress.filter(({ detail }) => detail.includes("ranking consistency"));
            assert.equal(rankingProgress.length, 18);
            assert.deepEqual(rankingProgress.map(({ completed }) => completed), Array.from({ length: 18 }, (_, i) => i));
            assert.ok(rankingProgress.every(({ phase, total }) => phase === "aggregate" && total === 17));
            assert.deepEqual(measured.rankingMeasurement, (await runOpenScoreUsdReplay(source(pairs), undefined, options)).rankingMeasurement);
        }
    });
});
