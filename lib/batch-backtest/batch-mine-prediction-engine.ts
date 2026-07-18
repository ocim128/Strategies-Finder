/**
 * Mine Prediction diagnostic — does Mine Timing's analog-engine output
 * correlate with realized forward return?
 *
 * Mine Timing emits per-asset verdicts with analog-study statistics
 * (expectedForwardReturnPct, oosLiftPct, confidence). Portfolio Fit uses
 * oosLiftPct as its "edge%" — but nothing measures whether those statistics
 * track reality. The codebase flags this gap itself:
 * batch-portfolio-fit-summary.ts:37 emits "Independent validation unavailable
 * (historical Stability reconstruction not implemented)".
 *
 * This leaf closes that gap by BACKTESTING Mine's real engine at many
 * historical bars where the forward window has fully elapsed. For each
 * sampled bar N on each asset: slice target OHLCV to [:N+1] (Mine has no
 * bar-index param — it always verdicts at data.length-1,
 * batch-synthetic-state-miner.ts:558), run the real Mine engine
 * (runPreparedBatchSyntheticStateMiner), record the predicted value
 * (expectedForwardReturnPct) AND the realized forward return from the FULL
 * OHLCV at [N, N+horizon], signed by verdict direction.
 *
 * Then reports rank IC of predicted-vs-realized, hit rate by direction,
 * confidence calibration, lift-vs-realized correlation, per-asset breakdown,
 * and a sign-aware verdict anchored to the primary horizon.
 *
 * Pure leaf: imports ../types/strategies and ./batch-synthetic-state-miner
 * only. No lightweight-charts (avoids the vite.config bundle trap).
 *
 * A weak/negative result is the expected honest outcome and is valuable: it
 * retires the question with measurement instead of suspicion.
 */
import type { OHLCVData } from "../types/strategies";
import {
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticPreparedPairArtifact,
    type BatchSyntheticTargetArtifact,
    type BatchSyntheticVerdict,
} from "./batch-synthetic-state-miner";

// ============================================================================
// Public types
// ============================================================================

export interface BatchMinePredictionSample {
    asset: string;
    barN: number;
    /** Mine's actual verdict classification (LONG/SHORT/WATCH/SKIP/INCONCLUSIVE). */
    verdict: BatchSyntheticVerdict;
    /** The underlying market-state direction. Can be non-null even when verdict
     *  is WATCH/SKIP/INCONCLUSIVE — do NOT use this to classify calls. */
    direction: "long" | "short" | null;
    confidence: string;
    predicted: number | null;
    oosLift: number | null;
    longestPredicted: number | null;
    analogCount: number;
    oosCount: number;
    realized: Map<number, number>;
}

export interface IcPoint { mean: number; tStat: number; n: number }

export interface HitRateBucket { p: number; lower: number; upper: number; n: number; meanReturn: number }

export interface BatchMinePredictionResult {
    strategyKey: string | null;
    interval: string | null;
    pairs: number;
    assets: number;
    samples: number;
    horizons: number[];
    rankIcByHorizon: Map<number, IcPoint>;
    hitRate: { long: HitRateBucket; short: HitRateBucket; none: HitRateBucket };
    longestHorizon: number;
    longestIc: number;
    primaryHorizon: number;
    primaryIc: number;
    primaryN: number;
    liftCorrByHorizon: Map<number, { corr: number; n: number }>;
    perAssetIc: Map<number, Map<string, { ic: number; n: number }>>;
    confidenceCalibration: Map<string, HitRateBucket>;
    caveats: string[];
    verdict: string;
    reportLines: string[];
}

export interface RunMinePredictionOptions {
    artifacts: BatchSyntheticPairArtifact[];
    targets: BatchSyntheticTargetArtifact[];
    interval: string;
    strategyKey?: string | null;
    horizons?: number[];
    sampleBars?: number;
    sampleStep?: number;
    lagBars?: number;
    minSamples?: number;
    minOosSamples?: number;
    neighborMin?: number;
    neighborMax?: number;
    /**
     * Restrict sampling to verdict bars within [sampleFromSec, sampleToSec]
     * (unix seconds, inclusive). Lets you measure regime-specific IC: e.g.
     * sample only the 2022 bear market to test whether Mine's edge survives
     * a down-trend, or only a post-COVID bull run to confirm where the edge
     * concentrates. Undefined = sample the full history. The bar's time is
     * the verdict bar's time, NOT the realized forward-return bar — so a
     * window of [2022-01-01, 2022-12-31] includes any verdict emitted during
     * 2022 even though its forward label extends into 2023.
     */
    sampleFromSec?: number;
    sampleToSec?: number;
    /**
     * Restrict ALL scoring (IC, hit-rate, calibration, edge, per-asset) to
     * verdicts of this direction. Critical for direction-biased strategies:
     * a long-only pair strategy should be scored on LONG verdicts alone,
     * because the SHORT verdicts are counter-predictive noise the trader
     * would never act on — including them drags the aggregate IC toward
     * zero and corrupts any pair-universe narrowing done off the result.
     * "both" (default) = include every direction as before. INCONCLUSIVE
     * (direction=null) bars are always retained as the baseline regardless
     * of the filter — they're the "Mine declined to call" reference.
     */
    directionFilter?: "both" | "long" | "short";
    /** Called after each asset's verdicts are collected, for streaming progress. */
    onAssetProgress?: (asset: string, samples: number, totalAssets: number, doneAssets: number) => void;
    /** Called after each bar within an asset, for live progress on slow assets. */
    onBarProgress?: (asset: string, barsDone: number, barsTotal: number) => void;
    /** Polled between assets; if it returns true, the run stops early (cancellation). */
    shouldStop?: () => boolean;
}

// ============================================================================
// Statistics (inline, single-use)
// ============================================================================

function rankArray(values: number[]): number[] {
    const idx = values.map((_, i) => i);
    idx.sort((a, b) => values[a]! - values[b]!);
    const ranks = new Array<number>(values.length).fill(0);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && values[idx[j + 1]!] === values[idx[i]!]) j += 1;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k += 1) ranks[idx[k]!] = avg;
        i = j + 1;
    }
    return ranks;
}

function spearman(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length < 2) return Number.NaN;
    const ra = rankArray(a);
    const rb = rankArray(b);
    const n = a.length;
    const ma = ra.reduce((x, y) => x + y, 0) / n;
    const mb = rb.reduce((x, y) => x + y, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i += 1) {
        const da = ra[i]! - ma, db = rb[i]! - mb;
        num += da * db; denA += da * da; denB += db * db;
    }
    if (denA === 0 || denB === 0) return Number.NaN;
    return num / Math.sqrt(denA * denB);
}

function pearson(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length < 2) return Number.NaN;
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i += 1) {
        const da = a[i]! - ma, db = b[i]! - mb;
        num += da * db; denA += da * da; denB += db * db;
    }
    if (denA === 0 || denB === 0) return Number.NaN;
    return num / Math.sqrt(denA * denB);
}

function aggregate(values: number[]): IcPoint {
    const valid = values.filter((v) => Number.isFinite(v));
    const n = valid.length;
    if (n === 0) return { mean: Number.NaN, tStat: Number.NaN, n: 0 };
    const mean = valid.reduce((a, b) => a + b, 0) / n;
    if (n === 1) return { mean, tStat: Number.NaN, n };
    const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    return { mean, tStat: std === 0 ? Number.NaN : (mean / std) * Math.sqrt(n), n };
}

function wilson(hits: number, total: number): { p: number; lower: number; upper: number } {
    if (total === 0) return { p: Number.NaN, lower: Number.NaN, upper: Number.NaN };
    const z = 1.959963984540054;
    const p = hits / total;
    const denom = 1 + (z * z) / total;
    const center = (p + (z * z) / (2 * total)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
    return { p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

const fmt = (x: number, digits = 4): string => (Number.isFinite(x) ? `${x > 0 ? "+" : ""}${x.toFixed(digits)}` : "n/a");
const fmtPct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

/** Format the date-range tag for the report header (empty if unbounded). */
function formatWindowTag(fromSec?: number, toSec?: number): string {
    const from = Number.isFinite(fromSec) ? new Date(fromSec! * 1000).toISOString().slice(0, 10) : null;
    const to = Number.isFinite(toSec) ? new Date(toSec! * 1000).toISOString().slice(0, 10) : null;
    if (!from && !to) return "";
    if (from && to) return ` window=${from}..${to}`;
    if (from) return ` window=${from}..`;
    return ` window=..${to}`;
}

// ============================================================================
// Per-bar verdict collection (the core backtest loop)
// ============================================================================

function computeRealized(
    fullData: OHLCVData[],
    N: number,
    horizons: number[],
    direction?: "long" | "short" | null,
): Map<number, number> {
    const out = new Map<number, number>();
    const sign = direction === "short" ? -1 : 1;
    const entryClose = fullData[N]!.close;
    for (const h of horizons) {
        const exitIdx = N + h;
        if (exitIdx >= fullData.length) { out.set(h, Number.NaN); continue; }
        const exitClose = fullData[exitIdx]!.close;
        if (!(entryClose > 0) || !Number.isFinite(exitClose)) { out.set(h, Number.NaN); continue; }
        out.set(h, sign * (exitClose / entryClose - 1));
    }
    return out;
}

/**
 * Slide backward through the asset's history, slice to [:N+1], run Mine,
 * record predicted vs realized. Mine always verdicts at data.length-1
 * (batch-synthetic-state-miner.ts:558), so slicing is the only supported way
 * to verdict at a historical bar.
 *
 * Pairs are prepared ONCE and reused across all bars (the prepare cost — ATR
 * index, open-trade adverse-ATR scan — is the dominant per-call expense).
 * Pair data past bar N has minor leakage into auto-horizons/adverse-ATR but
 * NOT into the current-snapshot lookup (which is bar-N-bounded by timeKey).
 * Documented tradeoff for the 10-100x speedup.
 */
function collectAssetSamples(
    opts: Required<Omit<RunMinePredictionOptions, "artifacts" | "targets" | "interval" | "strategyKey" | "onAssetProgress" | "onBarProgress" | "shouldStop" | "directionFilter">>,
    interval: string,
    asset: string,
    fullData: OHLCVData[],
    preparedPairs: BatchSyntheticPreparedPairArtifact[],
    symbol: string,
    onBarProgress?: (barsDone: number, barsTotal: number) => void,
    shouldStop?: () => boolean,
): BatchMinePredictionSample[] {
    const samples: BatchMinePredictionSample[] = [];
    const longestH = opts.horizons[opts.horizons.length - 1]!;
    const maxN = fullData.length - 1 - longestH;
    const minN = Math.max(opts.horizons[0]! * 4, 200);
    if (maxN <= minN) return samples;

    // Pre-compute the sampled bar list so we can report a stable total for
    // progress (the loop below may `continue` on prepare failures, which would
    // otherwise make barsTotal drift from barsDone).
    const sampledBars: number[] = [];
    for (let N = maxN; N > minN && sampledBars.length < opts.sampleBars; N -= opts.sampleStep) {
        // Date-range filter: skip bars whose verdict time falls outside the
        // requested window. sampleFromSec/sampleToSec are unix seconds; both
        // optional (undefined = unbounded on that side).
        const t = Number(fullData[N]!.time);
        if (!Number.isFinite(t)) continue;
        if (Number.isFinite(opts.sampleFromSec) && t < opts.sampleFromSec) continue;
        if (Number.isFinite(opts.sampleToSec) && t > opts.sampleToSec) continue;
        sampledBars.push(N);
    }
    const total = sampledBars.length;

    let collected = 0;
    for (const N of sampledBars) {
        if (shouldStop?.()) break;
        onBarProgress?.(collected, total);
        const sliced = fullData.slice(0, N + 1);
        const preparedTargets = prepareBatchSyntheticTargetArtifacts([
            { asset, symbol, data: sliced },
        ]);
        if (preparedTargets.length === 0) continue;

        let result;
        try {
            result = runPreparedBatchSyntheticStateMiner({
                interval,
                targets: preparedTargets,
                artifacts: preparedPairs,
                options: {
                    horizons: opts.horizons,
                    autoHorizons: false,
                    lagBars: opts.lagBars,
                    minSamples: opts.minSamples,
                    minOosSamples: opts.minOosSamples,
                    neighborCountMin: opts.neighborMin,
                    neighborCountMax: opts.neighborMax,
                },
            });
        } catch {
            continue;
        }

        const verdict = result.verdicts.find((v) => v.asset === asset || v.asset === asset.toUpperCase());
        if (!verdict) {
            samples.push({
                asset, barN: N, verdict: "INCONCLUSIVE", direction: null, confidence: "none",
                predicted: null, oosLift: null, longestPredicted: null,
                analogCount: 0, oosCount: 0,
                realized: computeRealized(fullData, N, opts.horizons),
            });
            collected += 1;
            continue;
        }

        samples.push({
            asset, barN: N,
            verdict: verdict.verdict,
            direction: verdict.direction,
            confidence: verdict.confidence,
            predicted: verdict.evidence.expectedForwardReturnPct,
            oosLift: verdict.evidence.oosLiftPct,
            longestPredicted: verdict.evidence.longestOosForwardReturnPct,
            analogCount: verdict.evidence.analogCount,
            oosCount: verdict.evidence.oosCount,
            realized: computeRealized(fullData, N, opts.horizons, verdict.direction),
        });
        collected += 1;
    }
    return samples;
}

// ============================================================================
// Main engine
// ============================================================================

export function runMinePredictionDiagnostic(options: RunMinePredictionOptions): BatchMinePredictionResult {
    // Defaults intentionally conservative: the engine re-runs Mine once per
    // sampled bar, and Mine scans the full candidate history per call, so
    // cost is ~O(history × samples). 25 samples per asset × every 80 bars
    // keeps a 24-asset universe under ~1-2 min while still giving ~600 total
    // verdicts (enough for rank IC). Raise sampleBars/lower sampleStep for
    // tighter stats on small universes.
    const opts = {
        horizons: options.horizons ?? [12, 24, 48],
        sampleBars: options.sampleBars ?? 25,
        sampleStep: options.sampleStep ?? 80,
        lagBars: options.lagBars ?? 3,
        minSamples: options.minSamples ?? 12,
        minOosSamples: options.minOosSamples ?? 4,
        neighborMin: options.neighborMin ?? 4,
        neighborMax: options.neighborMax ?? 24,
        // NaN = unbounded (Number.isFinite checks in the filter pass through).
        sampleFromSec: options.sampleFromSec ?? Number.NaN,
        sampleToSec: options.sampleToSec ?? Number.NaN,
    };
    const interval = options.interval;
    const strategyKey = options.strategyKey ?? null;
    const horizons = opts.horizons;

    const empty = (verdict: string): BatchMinePredictionResult => ({
        strategyKey, interval, pairs: options.artifacts.length, assets: 0, samples: 0, horizons,
        rankIcByHorizon: new Map(), hitRate: {
            long: emptyBucket(), short: emptyBucket(), none: emptyBucket(),
        },
        longestHorizon: horizons[horizons.length - 1] ?? 1,
        longestIc: Number.NaN, primaryHorizon: horizons[0] ?? 1, primaryIc: Number.NaN, primaryN: 0,
        liftCorrByHorizon: new Map(), perAssetIc: new Map(), confidenceCalibration: new Map(),
        caveats: [], verdict, reportLines: [`MINE_PRED | ${verdict}`],
    });

    if (options.artifacts.length === 0) return empty("No synthetic-pair artifacts to analyze.");
    if (options.targets.length === 0) return empty("No target asset candles loaded.");

    // Prepare pairs ONCE; reuse across all bar-N verdicts.
    const preparedPairs = prepareBatchSyntheticPairArtifacts(options.artifacts);
    if (preparedPairs.length === 0) return empty("No pair artifacts prepared (invalid metadata).");

    const allSamples: BatchMinePredictionSample[] = [];
    let doneAssets = 0;
    for (const target of options.targets) {
        if (options.shouldStop?.()) break;
        const samples = collectAssetSamples(
            opts, interval, target.asset, target.data, preparedPairs, target.symbol,
            (barsDone, barsTotal) => options.onBarProgress?.(target.asset, barsDone, barsTotal),
            options.shouldStop,
        );
        allSamples.push(...samples);
        doneAssets += 1;
        options.onAssetProgress?.(target.asset, samples.length, options.targets.length, doneAssets);
    }

    if (allSamples.length === 0) return empty("No verdict samples collected (check data depth, sample-bars, horizons).");

    const directionFilter = options.directionFilter ?? "both";
    // Filter samples by ACTUAL VERDICT before scoring, not by underlying
    // market-state direction. When directionFilter="long", keep only verdict
    // "LONG" + all non-call verdicts (WATCH/SKIP/INCONCLUSIVE as baseline).
    // This prevents WATCH-LONG or INCONCLUSIVE-LONG from leaking into the
    // LONG call bucket — they're not actionable entries.
    const filterVerdict: BatchSyntheticVerdict | null = directionFilter === "long" ? "LONG"
        : directionFilter === "short" ? "SHORT"
        : null;
    const scoredSamples = filterVerdict === null
        ? allSamples
        : allSamples.filter((s) => s.verdict === filterVerdict
            || s.verdict === "WATCH" || s.verdict === "SKIP" || s.verdict === "INCONCLUSIVE");

    const actionableInFiltered = scoredSamples.filter((s) =>
        (filterVerdict === null && (s.verdict === "LONG" || s.verdict === "SHORT"))
        || (filterVerdict !== null && s.verdict === filterVerdict)
    );
    if (actionableInFiltered.length === 0) {
        return empty(`NO_EDGE: no ${directionFilter === "both" ? "" : directionFilter + " "}actionable verdicts in the collected samples to score.`);
    }

    return buildReport({
        strategyKey, interval, pairCount: options.artifacts.length,
        assetCount: options.targets.length, samples: scoredSamples, horizons, opts,
        sampleFromSec: opts.sampleFromSec, sampleToSec: opts.sampleToSec, directionFilter,
    });
}

function emptyBucket(): HitRateBucket {
    return { p: Number.NaN, lower: Number.NaN, upper: Number.NaN, n: 0, meanReturn: Number.NaN };
}

function buildReport(args: {
    strategyKey: string | null;
    interval: string;
    pairCount: number;
    assetCount: number;
    samples: BatchMinePredictionSample[];
    horizons: number[];
    opts: { horizons: number[]; sampleBars: number; sampleStep: number };
    sampleFromSec?: number;
    sampleToSec?: number;
    directionFilter?: "both" | "long" | "short";
}): BatchMinePredictionResult {
    const { strategyKey, interval, pairCount, assetCount, samples, horizons } = args;
    const primaryH = horizons[0]!;
    const longestH = horizons[horizons.length - 1]!;

    // 1. Rank IC per horizon.
    const rankIcByHorizon = new Map<number, IcPoint>();
    for (const h of horizons) {
        const predicted: number[] = [];
        const realized: number[] = [];
        for (const s of samples) {
            if (s.predicted === null) continue;
            const r = s.realized.get(h);
            if (r === undefined || !Number.isFinite(r)) continue;
            predicted.push(s.predicted / 100);
            realized.push(r);
        }
        // Approximate t-stat via Fisher-style direction-agreement proxy.
        const agree = predicted.map((p, i) => (p > 0 === realized[i]! > 0 ? 1 : 0));
        const agg = aggregate(agree);
        rankIcByHorizon.set(h, { mean: spearman(predicted, realized), tStat: agg.tStat, n: predicted.length });
    }

    // 2. Hit rate by ACTUAL VERDICT (not direction) at primary horizon.
    // A WATCH-LONG or INCONCLUSIVE-LONG must NOT be counted as a LONG call.
    // Only verdict === "LONG" is an actionable long entry; verdict === "SHORT"
    // is an actionable short. WATCH/SKIP/INCONCLUSIVE are non-calls regardless
    // of their underlying direction.
    const byVerdict = { long: [] as number[], short: [] as number[], watch: [] as number[], skip: [] as number[], inconclusive: [] as number[] };
    for (const s of samples) {
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        if (s.verdict === "LONG") byVerdict.long.push(r);
        else if (s.verdict === "SHORT") byVerdict.short.push(r);
        else if (s.verdict === "WATCH") byVerdict.watch.push(r);
        else if (s.verdict === "SKIP") byVerdict.skip.push(r);
        else byVerdict.inconclusive.push(r);
    }
    const bucket = (arr: number[]): HitRateBucket => {
        if (arr.length === 0) return emptyBucket();
        const hits = arr.filter((r) => r > 0).length;
        const ci = wilson(hits, arr.length);
        return { ...ci, n: arr.length, meanReturn: arr.reduce((a, b) => a + b, 0) / arr.length };
    };
    const longBucket = bucket(byVerdict.long);
    const shortBucket = bucket(byVerdict.short);
    const watchBucket = bucket(byVerdict.watch);
    const skipBucket = bucket(byVerdict.skip);
    const inconclusiveBucket = bucket(byVerdict.inconclusive);
    // Non-call baseline = WATCH + SKIP + INCONCLUSIVE (everything Mine didn't
    // commit to as an actionable LONG/SHORT entry).
    const nonCallReturns = [...byVerdict.watch, ...byVerdict.skip, ...byVerdict.inconclusive];
    const nonCallBucket = bucket(nonCallReturns);
    const total = longBucket.n + shortBucket.n + nonCallBucket.n;
    const refusalRate = total > 0 ? nonCallBucket.n / total : 0;
    const baselineDrift = nonCallBucket.meanReturn;
    const longEdge = Number.isFinite(longBucket.meanReturn) && Number.isFinite(baselineDrift) ? longBucket.meanReturn - baselineDrift : Number.NaN;
    const shortEdge = Number.isFinite(shortBucket.meanReturn) && Number.isFinite(baselineDrift) ? shortBucket.meanReturn - baselineDrift : Number.NaN;

    // 3. Confidence calibration at primary horizon.
    const confidenceCalibration = new Map<string, HitRateBucket>();
    const byConf: Record<string, number[]> = { high: [], medium: [], low: [], none: [] };
    for (const s of samples) {
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        const key = byConf[s.confidence] ? s.confidence : "none";
        byConf[key]!.push(r);
    }
    for (const c of ["high", "medium", "low", "none"] as const) {
        confidenceCalibration.set(c, bucket(byConf[c]!));
    }

    // 4. Lift-vs-realized correlation per horizon.
    const liftCorrByHorizon = new Map<number, { corr: number; n: number }>();
    for (const h of horizons) {
        const lifts: number[] = [];
        const real: number[] = [];
        for (const s of samples) {
            if (s.oosLift === null) continue;
            const r = s.realized.get(h);
            if (r === undefined || !Number.isFinite(r)) continue;
            lifts.push(s.oosLift / 100);
            real.push(r);
        }
        liftCorrByHorizon.set(h, { corr: pearson(lifts, real), n: lifts.length });
    }

    // 5. Per-asset IC at primary horizon.
    const perAssetIc = new Map<number, Map<string, { ic: number; n: number }>>();
    const primaryAssetMap = new Map<string, { ic: number; n: number }>();
    const byAssetSamples = new Map<string, { pred: number[]; real: number[] }>();
    for (const s of samples) {
        if (s.predicted === null) continue;
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        const entry = byAssetSamples.get(s.asset) ?? { pred: [], real: [] };
        entry.pred.push(s.predicted / 100);
        entry.real.push(r);
        byAssetSamples.set(s.asset, entry);
    }
    for (const [asset, { pred, real }] of byAssetSamples) {
        primaryAssetMap.set(asset, { ic: spearman(pred, real), n: pred.length });
    }
    perAssetIc.set(primaryH, primaryAssetMap);

    // Primary + longest IC for verdict anchoring.
    const primaryIcData = rankIcByHorizon.get(primaryH)!;
    const longestIcData = rankIcByHorizon.get(longestH)!;
    const primaryIc = primaryIcData.mean;
    const longestIc = longestIcData.mean;

    // 6. Verdict (sign-aware, primary-horizon-anchored — the bug-fixed logic).
    let verdict: string;
    if (!Number.isFinite(primaryIc)) {
        verdict = `NO_EDGE: primary IC undefined (n too small).`;
    } else if (primaryIc <= -0.03) {
        verdict = `ANTI: primary h=${primaryH} IC=${fmt(primaryIc)} (n=${primaryIcData.n}) — Mine is counter-predictive at the trading horizon. Following it loses.`;
    } else if (primaryIc < 0.05) {
        verdict = `NO_EDGE: primary h=${primaryH} IC=${fmt(primaryIc)} (n=${primaryIcData.n}) — |IC| < 0.05; Mine predictions do not meaningfully correlate with realized. (longest h=${longestH} IC=${fmt(longestIc)})`;
    } else {
        verdict = `WEAK_PREDICTIVE: primary h=${primaryH} IC=${fmt(primaryIc)} (n=${primaryIcData.n}) — IC > 0.05. Check CALIB and EDGE for tradeability. (longest h=${longestH} IC=${fmt(longestIc)})`;
    }

    // 7. Caveats.
    const caveats: string[] = [];
    if (Number.isFinite(longBucket.meanReturn) && Number.isFinite(nonCallBucket.meanReturn) && longBucket.meanReturn - nonCallBucket.meanReturn < 0.005) {
        // Threshold is < 0.5% (0.005 fraction), NOT <= 0. LONG may still exceed
        // inconclusive-bar drift, just not by enough to clear the meaningful-edge
        // bar. Wording must match the condition (do NOT claim LONG < inconclusive).
        const diff = (longBucket.meanReturn - nonCallBucket.meanReturn) * 100;
        caveats.push(`LONG edge over inconclusive-bars is only ${fmt(diff, 2)}% (< 0.5% meaningful-edge threshold) — Mine's LONG selection adds little beyond passive-long drift`);
    }
    const highHit = confidenceCalibration.get("high")!;
    const lowHit = confidenceCalibration.get("low")!;
    if (highHit.n > 0 && lowHit.n > 0 && highHit.p < lowHit.p + 0.02) {
        caveats.push(`confidence not calibrated: high hit=${fmtPct(highHit.p)} does not beat low hit=${fmtPct(lowHit.p)}`);
    }
    const primaryLiftCorr = liftCorrByHorizon.get(primaryH)!;
    if (Number.isFinite(primaryLiftCorr.corr) && Math.abs(primaryLiftCorr.corr) < 0.05) {
        caveats.push(`oosLiftPct uncorrelated with realized (corr=${fmt(primaryLiftCorr.corr)}) — Portfolio Fit edge% is ungrounded`);
    }
    if (refusalRate > 0.5) {
        caveats.push(`high refusal rate ${fmtPct(refusalRate)} — Mine declines to verdict on most samples, small effective n`);
    }

    // 8. Build pipe-delimited report.
    const reportLines: string[] = [];
    reportLines.push(`MINE_PRED | strategy=${strategyKey ?? "?"} interval=${interval} assets=${assetCount} pairs=${pairCount} samples=${samples.length} horizons=${horizons.join(",")}${formatWindowTag(args.sampleFromSec, args.sampleToSec)}${args.directionFilter && args.directionFilter !== "both" ? ` direction=${args.directionFilter}` : ""}`);
    reportLines.push(`MINE_PRED | NOTE: rank_IC (predicted-vs-realized) is the primary score; realized is signed by verdict direction${args.directionFilter && args.directionFilter !== "both" ? `. Direction filter=${args.directionFilter}: scoring excludes the other direction's verdicts (INCONCLUSIVE bars retained as baseline).` : ""}`);


    const icParts = horizons.map((h) => {
        const a = rankIcByHorizon.get(h)!;
        return `h=${h} IC=${fmt(a.mean)} n=${a.n}`;
    });
    reportLines.push(`RANK_IC  | ${icParts.join(" | ")}`);
    reportLines.push(
        `RANK_IC | NOTE every horizon correlates Mine's PRIMARY-horizon prediction (expectedForwardReturnPct) against realized at that horizon — these are not separate per-horizon forecasts.`,
    );

    // VERDICTS count: how many of each verdict type were collected.
    const verdictCounts = { LONG: 0, SHORT: 0, WATCH: 0, SKIP: 0, INCONCLUSIVE: 0 };
    for (const s of samples) {
        verdictCounts[s.verdict] = (verdictCounts[s.verdict] ?? 0) + 1;
    }
    reportLines.push(
        `VERDICTS | LONG ${verdictCounts.LONG} | SHORT ${verdictCounts.SHORT} | WATCH ${verdictCounts.WATCH} | SKIP ${verdictCounts.SKIP} | INCONCLUSIVE ${verdictCounts.INCONCLUSIVE}`,
    );

    // CALL_IC: rank IC on ACTIONABLE verdicts only (LONG + SHORT), not
    // WATCH/SKIP/INCONCLUSIVE. This is the score that answers "are Mine's
    // actual entry calls predictive?" — distinct from FORECAST_IC (RANK_IC
    // above) which includes every finite analog prediction regardless of
    // whether Mine committed to a call.
    const callIcParts: string[] = [];
    for (const h of horizons) {
        const predicted: number[] = [];
        const realized: number[] = [];
        for (const s of samples) {
            if (s.verdict !== "LONG" && s.verdict !== "SHORT") continue;
            if (s.predicted === null) continue;
            const r = s.realized.get(h);
            if (r === undefined || !Number.isFinite(r)) continue;
            predicted.push(s.predicted / 100);
            realized.push(r);
        }
        const ic = spearman(predicted, realized);
        callIcParts.push(`h=${h} IC=${fmt(ic)} n=${predicted.length}`);
    }
    reportLines.push(`CALL_IC  | ${callIcParts.join(" | ")} (actionable LONG+SHORT verdicts only; compare to RANK_IC which includes all finite predictions)`);

    reportLines.push(
        `HIT_RATE | h=${primaryH} LONG(hit) ${fmtPct(longBucket.p)} CI[${fmtPct(longBucket.lower)},${fmtPct(longBucket.upper)}] n=${longBucket.n} | SHORT(hit) ${fmtPct(shortBucket.p)} CI[${fmtPct(shortBucket.lower)},${fmtPct(shortBucket.upper)}] n=${shortBucket.n} | WATCH n=${watchBucket.n} SKIP n=${skipBucket.n} INCONCLUSIVE n=${inconclusiveBucket.n} (refusal ${fmtPct(refusalRate)})`,
    );
    reportLines.push(
        `EDGE     | h=${primaryH} LONG edge vs inconclusive=${fmt(longEdge * 100, 2)}% | SHORT edge=${fmt(shortEdge * 100, 2)}% | inconclusive-bar passive-long drift=${fmt(baselineDrift * 100, 2)}% (NOT cash; direction=null defaults to long-sign)`,
    );
    const confParts = (["high", "medium", "low", "none"] as const).map((c) => {
        const b = confidenceCalibration.get(c)!;
        return `${c} hit=${fmtPct(b.p)} n=${b.n}`;
    });
    reportLines.push(`CALIB    | h=${primaryH} ${confParts.join(" | ")} (if high does not beat low, confidence label is meaningless)`);
    const liftParts = horizons.map((h) => {
        const a = liftCorrByHorizon.get(h)!;
        return `h=${h} corr=${fmt(a.corr)} n=${a.n}`;
    });
    reportLines.push(`LIFT_COR | ${liftParts.join(" | ")} (corr ~0 => Portfolio Fit edge% is ungrounded)`);
    const assetParts = Array.from(primaryAssetMap.entries()).map(([asset, a]) => `${asset} IC=${fmt(a.ic)} n=${a.n}`);
    assetParts.sort();
    reportLines.push(`PER_ASSET| h=${primaryH} ${assetParts.join(" | ")}`);
    if (caveats.length > 0) reportLines.push(`CAVEAT   | ${caveats.join(" | ")}`);
    reportLines.push(`VERDICT  | ${verdict}`);

    return {
        strategyKey, interval, pairs: pairCount, assets: assetCount, samples: samples.length, horizons,
        rankIcByHorizon, hitRate: { long: longBucket, short: shortBucket, none: nonCallBucket },
        longestHorizon: longestH, longestIc, primaryHorizon: primaryH, primaryIc, primaryN: primaryIcData.n,
        liftCorrByHorizon, perAssetIc, confidenceCalibration, caveats, verdict, reportLines,
    };
}
