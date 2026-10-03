import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanArtifacts } from "../lib/batch-backtest/open-score-replay/artifact-scan";
import { sweepScoreEvents } from "../lib/batch-backtest/open-score-replay/event-sweep";
import { scoreGraphStrength } from "../lib/batch-backtest/open-score-replay/graph-strength";
import { ScoreDeltaBuffer } from "../lib/batch-backtest/open-score-replay/score-delta-buffer";
import type { ScoreDelta } from "../lib/batch-backtest/open-score-replay/internal-types";
import { TemporalSupport } from "../lib/batch-backtest/open-score-replay/temporal-support";
import { prepareCausalPriceHistory, causalPriceStrength } from "../lib/batch-backtest/open-score-replay/causal-target-scores";
import { runOpenScoreUsdReplay } from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { toBatchSyntheticPairAdapter, type CompactPairArtifact, type CompactTrade } from "../lib/batch-backtest/compact-pair-artifact";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { OHLCVData } from "../lib/types/strategies";
import { CAUSAL_ARM_FIELDS, LEGACY_REPLAY_ARM_FIELDS } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { buildAssetSwitchDecisions, buildCandidateViews, captureRankingEvent, selectAfterOutcomes } from "../lib/batch-backtest/open-score-replay/candidate-selection";
import { createEmptyRankingMeasurement, compactRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import { addCausalPriceScores } from "../lib/batch-backtest/open-score-replay/causal-target-scores";

const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const trade = (entryTime: number, exitTime: number, type: "long" | "short" = "long", open = false): CompactTrade => ({ entryTime: entryTime as CompactTrade["entryTime"], exitTime: exitTime as CompactTrade["exitTime"], type, pnl: 1, exitReason: open ? "end_of_data" : "signal" });
const pair = (baseAsset: string, quoteAsset: string, trades: CompactTrade[], pairIndex = 0): BatchSyntheticPairArtifact => toBatchSyntheticPairAdapter({ schema: "compact_pair_artifact.v1", pairIndex, baseAsset, quoteAsset, baseSymbol: baseAsset, quoteSymbol: quoteAsset, symbol: `${baseAsset}/${quoteAsset}`, trades, netProfit: 1 } as CompactPairArtifact) as unknown as BatchSyntheticPairArtifact;
const source = (pairs: BatchSyntheticPairArtifact[]) => () => (async function* () { yield* pairs; })();
const candles = (count = 90): OHLCVData[] => Array.from({ length: count }, (_, i) => ({ time: i * 60 as OHLCVData["time"], open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i, volume: 1 }));
const scan = (pairs: BatchSyntheticPairArtifact[], enabled = true) => scanArtifacts({ artifactLoader: source(pairs), shouldStop: () => false, onPhase() {}, capTiltWeight: null, lookupMarketCap: null, capTiltActive: false, sampleFromSec: undefined, sampleToSec: undefined, enableCausalArms: enabled });

describe("Finder additional causal arms", () => {
    it("freezes valid loaded degree independently of trades and legacy retained degree", async () => {
        const result = await scan([pair("A", "Q", [trade(0, 600)]), pair("A", "R", []), pair("A", "A", []), pair("", "Q", []), pair("B", "Q", [trade(0, 9999, "short", true)])]);
        assert.ok(result.ok);
        assert.equal(result.result.validDegree!.get("A"), 2);
        assert.equal(result.result.retainedDegree.get("A"), 3);
        assert.equal(result.result.validDegree!.get("Q"), 2);
        assert.deepEqual(result.result.pairEndpoints, [{ base: 0, quote: 1 }, { base: 3, quote: 1 }]);
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
        near(event.causalScores!.get(a)!.topCoverage, 0.5);
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

    it("solves chains, inconsistent cycles, orientation, zero RHS and deterministic component ties", async () => {
        const names = ["A", "B", "C", "D", "E", "F"];
        const edges = [{ base: 0, quote: 1, vote: 1, count: 1 }, { base: 1, quote: 2, vote: 2, count: 2 }];
        const chain = await scoreGraphStrength(names, edges); near(chain.scores.get(0), 1); near(chain.scores.get(1), 0); near(chain.scores.get(2), -1);
        const triangle = await scoreGraphStrength(names, [...edges, { base: 0, quote: 2, vote: 1, count: 1 }]); near(triangle.scores.get(0), 2 / 3); near(triangle.scores.get(2), -2 / 3);
        const reversed = await scoreGraphStrength(names, edges.reverse().map((edge) => ({ base: edge.quote, quote: edge.base, count: edge.count, vote: -edge.vote })));
        assert.deepEqual(reversed.scores, chain.scores);
        const disconnected = await scoreGraphStrength(names, [...edges, { base: 3, quote: 4, vote: 1, count: 1 }, { base: 4, quote: 5, vote: 1, count: 1 }]);
        assert.deepEqual([...disconnected.component], [0, 1, 2]);
        const split = await scoreGraphStrength(names, [{ base: 0, quote: 1, vote: 0, count: 2 }, { base: 1, quote: 2, vote: 1, count: 0 }]);
        assert.deepEqual([...split.scores.values()], [0, 0]);
        assert.equal((await scoreGraphStrength(names, [{ base: 0, quote: 1, vote: NaN, count: 1 }])).failed, true);
        assert.equal((await scoreGraphStrength(names, [{ base: 0, quote: 1, vote: 1, count: 1 }], () => false, 0)).failed, true);
        // Stop is observed at solve entry only; the sweep owns the per-bucket checks.
        await assert.rejects(scoreGraphStrength(names, edges, () => true), /cancelled/);
    });

    it("counts each failed graph solve exactly once in the causal diagnostics", async () => {
        const deltas: ScoreDelta[] = [{ entrySec: 0, timeSec: 0, assetIndex: 0, delta: NaN, isEntry: 1, pnlShare: 0, voteApplied: true, profitNowConfidenceWeight: 0 }];
        const outcome = await sweepScoreEvents({
            enableCausalArms: true,
            interval: "1m",
            mode: "horizon",
            assetNames: ["A", "Q"],
            validDegree: new Map([["A", 1], ["Q", 1]]),
            pairEndpoints: [{ base: 0, quote: 1 }],
            streams: [ScoreDeltaBuffer.from(deltas, true)],
            profitableStreams: [true],
            sampleFromSec: undefined,
            sampleToSec: undefined,
            shouldStop: () => false,
            onPhase() {},
            pairCount: 1,
            assetCount: 2,
        });
        assert.ok(outcome.ok);
        assert.equal(outcome.result.events.length, 1);
        assert.equal(outcome.result.causalArmDiagnostics!.graphSolverFailures, 1);
    });

    it("uses exactly 25 completed positive closes, population volatility and the causal prefix", () => {
        const data = candles();
        const history = prepareCausalPriceHistory(data, "1m", 5000);
        const returns = data.slice(1, 25).map((c, i) => Math.log(c.close / data[i]!.close));
        const sum = returns.reduce((a, b) => a + b, 0), mean = sum / 24, std = Math.sqrt(returns.reduce((v, r) => v + (r - mean) ** 2, 0) / 24);
        near(causalPriceStrength(history, 1500, 60), sum / (Math.sqrt(24) * std));
        assert.equal(causalPriceStrength(history, 1499, 60), undefined);
        const futureChanged = data.map((c, i) => i >= 25 ? { ...c, close: 1e9 } : c);
        assert.equal(causalPriceStrength(prepareCausalPriceHistory(futureChanged, "1m", 5000), 1500, 60), causalPriceStrength(history, 1500, 60));
        assert.equal(causalPriceStrength(prepareCausalPriceHistory(data.map((c) => ({ ...c, close: 100 })), "1m", 5000), 1500, 60), 0);
        assert.equal(causalPriceStrength(prepareCausalPriceHistory(data.map((c, i) => i === 4 ? { ...c, close: 0 } : c), "1m", 5000), 1500, 60), undefined);
        assert.equal(causalPriceStrength(history, 5000 + 31 * 86400, 60), undefined);
        const gapped = data.map((c, i) => ({ ...c, time: (i * 60 + (i >= 12 ? 31 * 86400 : 0)) as OHLCVData["time"] }));
        assert.equal(causalPriceStrength(prepareCausalPriceHistory(gapped, "1m", Infinity), 1500 + 31 * 86400, 60), undefined);
        const weekend = data.map((c, i) => ({ ...c, time: (i * 60 + (i >= 12 ? 2 * 86400 : 0)) as OHLCVData["time"] }));
        assert.ok(Number.isFinite(causalPriceStrength(prepareCausalPriceHistory(weekend, "1m", Infinity), 1500 + 2 * 86400, 60)));
        const iso = data.map((c) => ({ ...c, time: new Date(Number(c.time) * 1000).toISOString() as OHLCVData["time"] }));
        near(causalPriceStrength(prepareCausalPriceHistory(iso, "1m", 5000), 1500, 60), sum / (Math.sqrt(24) * std));
        const invalid = data.map((c, i) => i === 10 ? { ...c, time: data[9]!.time } : c);
        assert.equal(causalPriceStrength(prepareCausalPriceHistory(invalid, "1m", 5000), 1500, 60), undefined);
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
            assert.equal(enabled.causalArmDefinitions!.version, "finder-causal-arms-v1");
            assert.equal(enabled.causalArmDiagnostics!.eligibleCandidates.topPriceStrength, 6);
        });
    }

    it("preserves old 15-arm ranking data without manufacturing new summaries; validates additions independently", () => {
        const legacy = createEmptyRankingMeasurement(5);
        const compact = compactRankingMeasurement(legacy)!;
        assert.deepEqual(compact, legacy);
        assert.equal(compact.arms.topCoverage, undefined);
        const enabled = createEmptyRankingMeasurement(5, true);
        assert.deepEqual(compactRankingMeasurement(enabled), enabled);
        enabled.arms.topGraphStrength!.scoredEvents = -1;
        const recovered = compactRankingMeasurement(enabled)!;
        assert.deepEqual(recovered.arms.topRaw, legacy.arms.topRaw); assert.equal(recovered.arms.topGraphStrength, undefined);
    });

    it("freezes score keys, top-five membership and picks before forward inspection in both modes", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), trade(1500, 9999, "long", true)]));
        const result = await scan(pairs); assert.ok(result.ok); const s = result.result;
        const swept = await sweepScoreEvents({ ...s, enableCausalArms: true, interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length }); assert.ok(swept.ok);
        for (const keys of swept.result.events[0]!.causalScores!.values()) keys.topPriceStrength = -10;
        const views = await buildCandidateViews({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, onPhase() {} }); assert.ok(views.ok);
        const ranking = captureRankingEvent(1500, views.result.views[0]!, s.assetNames, true);
        assert.equal(ranking.arms.topPriceStrength.picks.length, 5); assert.equal(ranking.arms.topPriceStrength.picks[0]!.key, -10);
        assert.equal(ranking.arms.topPriceStrength.reason, undefined);
        const compactResult = await scan(pairs); assert.ok(compactResult.ok); const cs = compactResult.result;
        const compactSweep = await sweepScoreEvents({ ...cs, enableCausalArms: true, mode: "asset_switch", interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: cs.assetNames.length }); assert.ok(compactSweep.ok);
        assert.equal(compactSweep.result.events[0]!.causalScores, undefined);
        const switches = await buildAssetSwitchDecisions({ events: compactSweep.result.events, totalEvents: 1, assetNames: cs.assetNames, assetCount: cs.assetNames.length, enableCausalArms: true, captureRanking: true, onPhase() {} }); assert.ok(switches.ok);
        assert.equal(switches.result.decisions[0]!.eligiblePoolCounts!.topCoverage, 6);
        assert.ok(switches.result.rankingEvents![0]!.arms.topGraphStrength.picks.length <= 5);
    });

    for (const mode of ["horizon", "asset_switch"] as const) {
        it(`keeps price keys, top five and picks unchanged by future prices and gaps: ${mode}`, async () => {
            const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), trade(1500, 9999, "long", true)]));
            const freeze = async (changeFuture: boolean) => {
                const scanned = await scan(pairs); assert.ok(scanned.ok); const s = scanned.result;
                const swept = await sweepScoreEvents({ ...s, enableCausalArms: true, mode, interval: "1m", sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length }); assert.ok(swept.ok);
                await addCausalPriceScores(swept.result.events, s.assetNames, {
                    interval: "1m", evaluationCutoffSec: 5000,
                    loadTargetDataset: async (name) => candles().map((c, i) => ({ ...c,
                        close: i < 25 || !changeFuture ? c.close + name.charCodeAt(0) : 1e9,
                        time: (Number(c.time) + (changeFuture && i >= 25 ? 31 * 86400 : 0)) as OHLCVData["time"],
                    })),
                }, swept.result.causalArmDiagnostics!);
                if (mode === "asset_switch") {
                    const stage = await buildAssetSwitchDecisions({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, captureRanking: true, onPhase() {} }); assert.ok(stage.ok);
                    return { picks: stage.result.rankingEvents![0]!.arms.topPriceStrength.picks,
                        selected: stage.result.decisions[0]!.picks.topPriceStrength,
                        eligible: stage.result.decisions[0]!.eligiblePoolCounts!.topPriceStrength };
                }
                const stage = await buildCandidateViews({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, onPhase() {} }); assert.ok(stage.ok);
                const view = stage.result.views[0]!, ranking = captureRankingEvent(1500, view, s.assetNames, true);
                const selected = view.causalPicks!.topPriceStrength!;
                // A later target gap must not replace the new arm's cooldown pick.
                const post = await selectAfterOutcomes({ views: stage.result.views, profitOnlyEvents: [], assetNames: s.assetNames,
                    enableCausalArms: true, selectionCooldownBars: 1,
                    boundaryIndicesByView: [new Map(view.positives.map((c) => [c.assetIndex, 25]))],
                    dataGapAssets: changeFuture ? new Map([[selected, true]]) : new Map(), dataGapEvents: new Set() });
                assert.equal(post.armSelectionsByView![0]!.topPriceStrength!.selectedAssetIndex, selected);
                return { picks: ranking.arms.topPriceStrength.picks, selected, eligible: view.positives.length };
            };
            assert.deepEqual(await freeze(true), await freeze(false));
        });
    }

    it("honors Stop during the separate price-loading pass", async () => {
        let stopped = false;
        await assert.rejects(runOpenScoreUsdReplay(source([pair("A", "Q", [trade(0, 9999, "long", true)])]), undefined, { enableCausalArms: true, interval: "1m", horizons: [2], shouldStop: () => stopped, loadTargetDataset: async () => { stopped = true; return null; } }), /cancelled during causal price loading/);
    });

    it("uses independently calculated keys, including negative and zero keys in positive pools", async () => {
        const pairs = [pair("B", "Q", [trade(0, 9999, "long", true)]), pair("A", "Q", [trade(1500, 9999, "long", true), trade(1500, 9999, "long", true)])];
        const scanned = await scan(pairs); assert.ok(scanned.ok); const s = scanned.result;
        const swept = await sweepScoreEvents({ ...s, interval: "1m", enableCausalArms: true, sampleFromSec: 1500, sampleToSec: 1500, shouldStop: () => false, onPhase() {}, assetCount: s.assetNames.length }); assert.ok(swept.ok);
        await addCausalPriceScores(swept.result.events, s.assetNames, { interval: "1m", evaluationCutoffSec: 5000, loadTargetDataset: async (asset) => candles().map((c) => asset === "A" ? { ...c, close: 100 } : c) }, swept.result.causalArmDiagnostics!);
        const stage = await buildCandidateViews({ events: swept.result.events, totalEvents: 1, assetNames: s.assetNames, assetCount: s.assetNames.length, enableCausalArms: true, onPhase() {} }); assert.ok(stage.ok);
        const view = stage.result.views[0]!;
        assert.equal(s.assetNames[view.topRaw], "A");
        assert.equal(s.assetNames[view.causalPicks!.topPriceStrength!], "B");
        assert.equal(s.assetNames[view.causalPicks!.topStableSupport!], "B");
        assert.equal(s.assetNames[view.causalPicks!.topFreshSupport!], "A");
        const selected = await selectAfterOutcomes({ views: stage.result.views, profitOnlyEvents: [], assetNames: s.assetNames,
            enableCausalArms: true, dataGapAssets: new Map([[view.causalPicks!.topPriceStrength!, true]]), dataGapEvents: new Set() });
        const latest = selected.latestSelections!.selections;
        const price = latest.find((row) => row.selector === "TOP_PRICE_STRENGTH")!;
        assert.equal(price.asset, "B", "later gaps must not alter a causal latest pick");
        assert.equal(price.rankingScore, view.positives.find((c) => s.assetNames[c.assetIndex] === "B")!.topPriceStrength);
        assert.equal(price.topCandidates![0]!.asset, "B");
        assert.equal(latest.find((row) => row.selector === "TOP_FRESH_SUPPORT")!.asset, "A");
        assert.equal(latest.find((row) => row.selector === "TOP_STABLE_SUPPORT")!.asset, "B");
        near(view.positives.find((c) => s.assetNames[c.assetIndex] === "A")!.topCoverage, 2);
        const ranking = captureRankingEvent(1500, { positives: Array.from({ length: 6 }, (_, assetIndex) => ({ assetIndex, raw: assetIndex + 1, adjusted: 1, activePairs: 1, mean: 1, topCoverage: -assetIndex, topStableSupport: assetIndex, topFreshSupport: 0, topPriceStrength: -assetIndex, topGraphStrength: assetIndex })) }, ["A", "B", "C", "D", "E", "F"], true);
        assert.equal(ranking.arms.topCoverage.picks[0]!.assetIndex, 0);
        assert.equal(ranking.arms.topGraphStrength.picks[0]!.assetIndex, 5);
    });

    it("does not reload known missing targets, and restricts only the price pool", async () => {
        const pairs = ["A", "B", "C", "D", "E", "F"].map((name) => pair(name, "Q", [trade(0, 9999, "long", true), trade(1500, 9999, "long", true)]));
        let missingLoads = 0;
        const result = await runOpenScoreUsdReplay(source(pairs), undefined, { enableCausalArms: true, horizons: [2], rankingHorizon: 2, interval: "1m", sampleFromSec: 1500, sampleToSec: 1600, evaluationCutoffSec: 5000,
            loadTargetDataset: async (asset) => asset === "F" ? (missingLoads++, null) : candles() });
        assert.equal(missingLoads, 1);
        assert.equal(result.causalArmDiagnostics!.eligibleCandidates.topCoverage, 6);
        assert.equal(result.causalArmDiagnostics!.eligibleCandidates.topPriceStrength, 5);
        assert.equal(result.causalArmDiagnostics!.priceUnavailableReasons!.missing_target, 1);
        assert.equal(result.rankingMeasurement!.arms.topPriceStrength!.scoredEvents, 1);
        assert.equal(result.horizons[0]!.topPriceStrength!.events, 1);
        assert.equal(result.horizons[0]!.topCoverage!.events, 0);
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
        assert.equal(result.causalArmDefinitions!.version, "finder-causal-arms-v1");
    });
});
