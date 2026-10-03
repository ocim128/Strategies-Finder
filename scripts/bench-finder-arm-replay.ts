/**
 * Phase 0 benchmark (docs/finder-arm-performance-replay-efficiency-plan.md):
 * focused, fully deterministic replay benchmark for the OPEN_SCORE USD replay
 * engine. Ordered fixtures — immutable artifacts, target candles, horizons,
 * costs, blockCount. The fingerprint covers the FULL result (all 15
 * comparisons incl. randomMean/delta/medians/CIs/block counts, totals,
 * latestSelections), so any nondeterminism surfaces as a mismatch rather than
 * being excluded — unlike the sweep harness's events+topMean-only hash.
 *
 * Fixture modes (composable): --gaps punches a candle gap into one base
 * asset's target (exercises the gap-rerank path); --missing-targets drops one
 * asset's target entirely (missing-target backfill); --ties makes all assets'
 * pnl identical per event (tie-heavy selection, FNV digest path);
 * --interleave replaces every 9th event with a profit-only event (one
 * ordinary positive, two profit-pool positives) whose decision times
 * interleave chronologically with the ordinary views, so profit-arm series
 * reach splitIntoBlocks out of order;
 * --sparse makes every pair short, so +1 votes land on the 10 cycling quote
 * assets and ordinary positive pools stay tiny (redundant-work plan phase 0).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdReplayResult,
    type OpenScoreUsdTarget,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { ReplayMode } from "../lib/batch-backtest/open-score-replay/types";
import { LEGACY_REPLAY_ARM_FIELDS } from "../lib/batch-backtest/open-score-replay/arm-contract";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const T0 = 1_700_000_000;
const BAR_SEC = 100;

interface BenchArgs {
    causalArms: boolean;
    interval: string;
    ranking: boolean;
    assets: number;
    events: number;
    eventSpacingSec: number;
    horizons: string;
    profile: boolean;
    gaps: boolean;
    missingTargets: boolean;
    ties: boolean;
    interleave: boolean;
    sparse: boolean;
    mode: ReplayMode;
    longHolds: boolean;
    frequentSwitches: boolean;
    stopAfterSwitchMs: number | null;
    label: string;
    outDir: string;
}

function parseArgs(argv: readonly string[]): BenchArgs {
    const args: BenchArgs = {
        causalArms: false,
        interval: "4h",
        ranking: false,
        assets: 60,
        events: 2000,
        eventSpacingSec: 300,
        horizons: "5",
        profile: false,
        gaps: false,
        missingTargets: false,
        ties: false,
        interleave: false,
        sparse: false,
        mode: "horizon",
        longHolds: false,
        frequentSwitches: false,
        stopAfterSwitchMs: null,
        label: `replay-${Date.now()}`,
        outDir: "artifacts/arm-replay-eff-bench",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]!;
        const value = argv[i + 1];
        const take = (): string => {
            if (value === undefined) throw new Error(`Missing value for ${flag}`);
            i += 1;
            return value;
        };
        switch (flag) {
            case "--causal-arms": args.causalArms = true; break;
            case "--interval": args.interval = take(); break;
            case "--ranking": args.ranking = true; break;
            case "--assets": args.assets = Number(take()); break;
            case "--events": args.events = Number(take()); break;
            case "--event-spacing": args.eventSpacingSec = Number(take()); break;
            case "--horizons": args.horizons = take(); break;
            case "--profile": args.profile = true; break;
            case "--gaps": args.gaps = true; break;
            case "--missing-targets": args.missingTargets = true; break;
            case "--ties": args.ties = true; break;
            case "--interleave": args.interleave = true; break;
            case "--sparse": args.sparse = true; break;
            case "--mode": {
                const mode = take();
                if (mode !== "horizon" && mode !== "asset_switch") throw new Error("--mode must be horizon or asset_switch");
                args.mode = mode;
                break;
            }
            case "--long-holds": args.longHolds = true; break;
            case "--frequent-switches": args.frequentSwitches = true; break;
            case "--stop-after-switch-ms": {
                const ms = Number(take());
                if (!Number.isFinite(ms) || ms < 0) throw new Error("--stop-after-switch-ms must be a non-negative number");
                args.stopAfterSwitchMs = ms;
                break;
            }
            case "--label": args.label = take(); break;
            case "--out-dir": args.outDir = take(); break;
            default: throw new Error(`Unknown flag ${flag}`);
        }
    }
    if (args.longHolds && args.frequentSwitches) {
        throw new Error("--long-holds and --frequent-switches are separate benchmark profiles");
    }
    if ((args.longHolds || args.frequentSwitches || args.stopAfterSwitchMs !== null) && args.mode !== "asset_switch") {
        throw new Error("switch benchmark profiles require --mode asset_switch");
    }
    return args;
}

function fail(message: string): never {
    console.error(`BENCH FAIL: ${message}`);
    process.exit(1);
}

function emptyResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

let tradeId = 0;
function makeTrade(type: "long" | "short", entrySec: number, exitSec: number | null, pnl: number): Trade {
    tradeId += 1;
    return {
        id: tradeId,
        type,
        entryTime: entrySec as Time,
        entryPrice: 100,
        exitTime: (exitSec ?? entrySec + 120) as Time,
        exitPrice: 100 + pnl,
        pnl,
        pnlPercent: 0,
        size: 1,
        exitReason: exitSec === null ? "end_of_data" : "signal",
    };
}

function makePair(
    base: string,
    quote: string,
    trades: Trade[],
    netProfit: number,
): BatchSyntheticPairArtifact {
    return {
        symbol: `${base}+${quote}`,
        baseAsset: base,
        quoteAsset: quote,
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades, netProfit },
    };
}

interface Fixture {
    pairs: BatchSyntheticPairArtifact[];
    targets: OpenScoreUsdTarget[];
    horizons: number[];
    blockCount: number;
}

function buildFixture(args: BenchArgs): Fixture {
    const { assets, events, eventSpacingSec, horizons: horizonArg, gaps, missingTargets, ties, interleave, sparse, longHolds, frequentSwitches } = args;
    const horizons = horizonArg.split(",").map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
    const spanSec = events * eventSpacingSec;
    const targetBars = Math.ceil((spanSec + 4 * eventSpacingSec) / BAR_SEC);

    // Deterministic per-asset price walk (xorshift keyed by asset index), so
    // long returns vary by asset and the selectors have real winners.
    const priceAt = (assetIdx: number) => (i: number): number => {
        let x = (assetIdx * 2654435761 + i * 40503) >>> 0;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        return 100 + ((x >>> 0) % 200) / 10;
    };

    const pairs: BatchSyntheticPairArtifact[] = [];
    const targets: OpenScoreUsdTarget[] = [];
    // Dedicated profit-only event assets/pairs (--interleave). At an
    // interleave slot every IVOTEx pair enters long, so ordinary scores are
    // PIA +2, PIB1 0, PIB2 0, PIQ -2 (one positive -> no ordinary view) while
    // profit scores are PIB1 +1, PIB2 +1 (profit-only event). The slot sits
    // BETWEEN ordinary slots, so profit-arm decision times interleave with
    // the ordinary views' times.
    const interleaveSlot = (e: number): boolean => interleave && e % 9 === 4;
    const interleaveTarget = (name: string, assetIdx: number): OpenScoreUsdTarget => ({
        asset: name,
        symbol: `${name}USDT`,
        data: Array.from({ length: targetBars }, (_, i) => {
            const p = priceAt(assetIdx)(i);
            return { time: (T0 + i * BAR_SEC) as Time, open: p, high: p, low: p, close: p, volume: 1 };
        }),
    });
    const interleaveVote = (base: string, quote: string, profit: boolean): BatchSyntheticPairArtifact => {
        const trades: Trade[] = [];
        for (let e = 0; e < events; e += 1) {
            if (!interleaveSlot(e)) continue;
            const entry = T0 + e * eventSpacingSec + 60;
            trades.push(makeTrade("long", entry, entry + 120, profit ? 0.2 : -0.1));
        }
        return makePair(base, quote, trades, trades.reduce((s, t) => s + t.pnl, 0));
    };
    if (interleave) {
        pairs.push(interleaveVote("PIA", "PIB1", false));
        pairs.push(interleaveVote("PIA", "PIB2", false));
        pairs.push(interleaveVote("PIB1", "PIQ", true));
        pairs.push(interleaveVote("PIB2", "PIQ", true));
        targets.push(interleaveTarget("PIA", 1000 + assets));
        targets.push(interleaveTarget("PIB1", 1000 + assets + 1));
        targets.push(interleaveTarget("PIB2", 1000 + assets + 2));
    }
    for (let a = 0; a < assets; a += 1) {
        const base = `B${String(a).padStart(3, "0")}`;
        const quote = `Q${String(a % 10).padStart(3, "0")}`;
        // Every asset trades on every other decision slot (skipping every 5th
        // deterministically), so most events have >= 2 pool candidates.
        const trades: Trade[] = [];
        for (let e = 0; e < events; e += 1) {
            if (interleaveSlot(e)) continue;
            if (frequentSwitches) {
                if (a === e % assets) {
                    const entry = T0 + e * eventSpacingSec + 60;
                    trades.push(makeTrade("long", entry, entry + 120, 0.2));
                }
                continue;
            }
            if (longHolds && a !== 0) continue;
            if ((e + a) % 2 === 0 && (e * 7 + a * 13) % 5 !== 0) {
                const entry = T0 + e * eventSpacingSec + 60;
                const pnl = ties
                    ? 0.05
                    : (((a * 31 + e * 17) % 41) - 20) / 100;
                // Short pairs put their +1 vote on the quote leg; with the
                // cycling quotes only 10 assets wide, ordinary positive pools
                // stay tiny instead of covering half the asset list.
                trades.push(makeTrade(sparse && a % 2 === 0 ? "short" : "long", entry, entry + 120, pnl));
            }
        }
        pairs.push(makePair(base, quote, trades, trades.reduce((s, t) => s + t.pnl, 0)));
        const data: OHLCVData[] = Array.from({ length: targetBars }, (_, i) => {
            const p = priceAt(a)(i);
            return { time: (T0 + i * BAR_SEC) as Time, open: p, high: p, low: p, close: p, volume: 1 };
        });
        if (gaps && a === 0) {
            // Punch a contiguous hole into asset 0's candles after ~1/3 of the
            // window: the gap-rerank path must then exclude it from pools.
            const from = T0 + Math.floor(spanSec / 3);
            const to = from + eventSpacingSec * 2;
            const filtered = data.filter((bar) => Number(bar.time) < from || Number(bar.time) > to);
            data.length = 0;
            data.push(...filtered);
        }
        if (!(missingTargets && a === 1)) {
            targets.push({ asset: base, symbol: `${base}USDT`, data });
        }
    }
    return { pairs, targets, horizons, blockCount: 8 };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    console.log(`[bench] mode=${args.mode} assets=${args.assets} events=${args.events} spacing=${args.eventSpacingSec}s horizons=${args.horizons} gaps=${args.gaps} missingTargets=${args.missingTargets} ties=${args.ties} interleave=${args.interleave} sparse=${args.sparse} longHolds=${args.longHolds} frequentSwitches=${args.frequentSwitches}`);

    const fixture = buildFixture(args);

    const initialMemory = process.memoryUsage();
    let peakRss = initialMemory.rss;
    let peakHeap = initialMemory.heapUsed;
    let peakExternal = initialMemory.external + initialMemory.arrayBuffers;
    const sampler = setInterval(() => {
        const m = process.memoryUsage();
        if (m.rss > peakRss) peakRss = m.rss;
        if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
        if (m.external + m.arrayBuffers > peakExternal) peakExternal = m.external + m.arrayBuffers;
    }, 50);

    // Engine's own phase markers: each onPhase opens the NEXT phase, so the
    // delta between consecutive marks is the duration of the earlier phase.
    const phaseMarks: Array<{ phase: string; at: number }> = [];
    const onPhase = args.profile
        ? (phase: string): void => { phaseMarks.push({ phase, at: performance.now() }); }
        : undefined;

    const targetByAsset = new Map(fixture.targets.map((target) => [target.asset.toUpperCase(), target.data]));
    let targetReads = 0;
    let stopRequestedAt: number | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    const shouldStop = (): boolean => stopRequestedAt !== null;
    const onSwitchPhase = (phase: string): void => {
        onPhase?.(phase);
        if (phase === "switch" && args.stopAfterSwitchMs !== null && stopTimer === null) {
            stopTimer = setTimeout(() => { stopRequestedAt = performance.now(); }, args.stopAfterSwitchMs);
        }
    };
    let finalTargetOpenSec = Number.NEGATIVE_INFINITY;
    for (const target of fixture.targets) {
        for (const bar of target.data) finalTargetOpenSec = Math.max(finalTargetOpenSec, Number(bar.time));
    }
    if (!Number.isFinite(finalTargetOpenSec)) throw new Error("Benchmark fixture has no target candles.");
    const replayEndSec = finalTargetOpenSec + 4 * 60 * 60;

    const startedAt = performance.now();
    const result: OpenScoreUsdReplayResult = await runOpenScoreUsdReplay(
        () => (async function* () { for (const pair of fixture.pairs) yield pair; })(),
        () => (async function* () { for (const t of fixture.targets) yield t; })(),
        {
            enableCausalArms: args.causalArms,
            mode: args.mode,
            ...(args.ranking ? { rankingHorizon: fixture.horizons[0]! } : {}),
            ...(args.mode === "horizon" ? { horizons: fixture.horizons } : {}),
            interval: args.interval,
            slippageRate: 0,
            commissionRate: 0,
            blockCount: fixture.blockCount,
            loadTargetDataset: async (asset: string) => { targetReads += 1; return targetByAsset.get(asset.toUpperCase()) ?? null; },
            ...(args.mode === "asset_switch" ? {
                sampleToSec: replayEndSec,
                evaluationCutoffSec: replayEndSec,
                includeEventDetails: true,
                loadTargetDataset: async (asset: string) => {
                    targetReads += 1;
                    return targetByAsset.get(asset.toUpperCase()) ?? null;
                },
                shouldStop,
            } : {}),
            ...((onPhase || args.stopAfterSwitchMs !== null) ? { onPhase: onSwitchPhase } : {}),
        },
    );
    const wallMs = performance.now() - startedAt;
    if (stopTimer !== null) clearTimeout(stopTimer);
    clearInterval(sampler);

    const phaseDurations: Record<string, number> = {};
    for (let i = 1; i < phaseMarks.length; i += 1) {
        const phase = phaseMarks[i]!.phase;
        const delta = phaseMarks[i]!.at - phaseMarks[i - 1]!.at;
        phaseDurations[`until_${phase}`] = Math.round(delta);
    }

    // Canonical result serialization for the fingerprint (aggregation plan
    // phase 0): JSON.stringify collapses -0 to 0, so a plain stringify cannot
    // detect signed-zero regressions; this walker renders -0 distinctly. The
    // wall-clock `elapsed=` line in reportLines is instrumentation, not a
    // result, and is normalized before hashing.
    const serializeCanonical = (v: unknown): string => {
        if (typeof v === "number") return Object.is(v, -0) ? "-0" : JSON.stringify(v);
        if (Array.isArray(v)) return `[${v.map(serializeCanonical).join(",")}]`;
        if (v !== null && typeof v === "object") {
            return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${serializeCanonical(x)}`).join(",")}}`;
        }
        return JSON.stringify(v) ?? "null";
    };
    const normalizedResult = {
        ...result,
        reportLines: result.reportLines.map((line) => line.replace(/elapsed=[0-9.]+s/, "elapsed=Xs")),
    };
    const { rankingMeasurement: _ranking, ...originalResult } = normalizedResult;
    const originalFingerprint = createHash("sha256").update(serializeCanonical(originalResult)).digest("hex");
    const legacyArmFingerprint = createHash("sha256").update(serializeCanonical({
        horizons: result.horizons.map((horizon) => Object.fromEntries(LEGACY_REPLAY_ARM_FIELDS.map((field) => [field, {
            comparison: horizon[field], exclusion: horizon.armExTopContributorComparisons?.[field],
        }]))),
        switchArms: result.assetSwitch ? Object.fromEntries(LEGACY_REPLAY_ARM_FIELDS.map((field) => [field, result.assetSwitch!.arms[field]])) : null,
        ranking: result.rankingMeasurement ? Object.fromEntries(LEGACY_REPLAY_ARM_FIELDS.map((field) => [field, result.rankingMeasurement!.arms[field]])) : null,
    })).digest("hex");
    const fingerprint = createHash("sha256").update(serializeCanonical(normalizedResult)).digest("hex");
    const metrics = {
        label: args.label,
        wallMs,
        phaseDurations,
        peakRssBytes: peakRss,
        peakHeapBytes: peakHeap,
        peakExternalBytes: peakExternal,
        fingerprint,
        originalFingerprint,
        legacyArmFingerprint,
        causalArms: args.causalArms,
        interval: args.interval,
        ranking: args.ranking,
        mode: args.mode,
        targetReads,
        stopLatencyMs: stopRequestedAt === null ? null : performance.now() - stopRequestedAt,
        switchDetailRows: result.assetSwitch?.trades?.length ?? 0,
        switchDetailBytes: result.assetSwitch?.trades ? Buffer.byteLength(JSON.stringify(result.assetSwitch.trades)) : 0,
        switchTradeCount: result.assetSwitch?.tradeCount ?? 0,
        switchArmStatusCounts: result.assetSwitch
            ? Object.values(result.assetSwitch.arms).reduce((counts, arm) => {
                counts[arm.status] += 1;
                return counts;
            }, { complete: 0, no_entry: 0, incomplete: 0 })
            : null,
        totals: {
            pairs: result.pairs,
            assets: result.assets,
            totalEvents: result.totalEvents,
            candidateEvents: result.candidateEvents,
            eligibleEvents: result.eligibleEvents,
        },
    };
    const outDir = path.join(cwd, args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${args.label}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ metrics, result }, null, 2), "utf8");
    console.log(`[bench] wall=${wallMs.toFixed(0)}ms fingerprint=${fingerprint.slice(0, 12)} events=${result.totalEvents} candidate=${result.candidateEvents} eligible=${result.eligibleEvents} peakRssMB=${(peakRss / 1048576).toFixed(0)} peakHeapMB=${(peakHeap / 1048576).toFixed(0)} peakExtMB=${(peakExternal / 1048576).toFixed(0)}${args.mode === "asset_switch" ? ` targetReads=${targetReads} detailRows=${metrics.switchDetailRows}/${metrics.switchTradeCount} detailBytes=${metrics.switchDetailBytes} stopLatencyMs=${metrics.stopLatencyMs ?? "n/a"}` : ""}`);
    if (args.profile) console.log(`[bench] phases: ${JSON.stringify(phaseDurations)}`);
    console.log(`[bench] report: ${outPath}`);
}

main().catch((error: unknown) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
