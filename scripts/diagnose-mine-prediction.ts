/**
 * Diagnostic: does Mine Timing actually predict forward return?
 *
 * Mine Timing emits per-asset verdicts (LONG/SHORT/WATCH) with analog-study
 * statistics (expectedForwardReturnPct, oosLiftPct, confidence). Portfolio Fit
 * uses those statistics as its "edge%" — but nothing in the codebase measures
 * whether they correlate with REALIZED forward return. The codebase itself
 * flags this gap: batch-portfolio-fit-summary.ts:37 emits
 * "Independent validation unavailable (historical Stability reconstruction
 * not implemented)".
 *
 * This script closes that gap by BACKTESTING Mine's own engine at many
 * historical bars where the forward window has fully elapsed. For each
 * sampled bar N on each asset:
 *   - slice target OHLCV to [:N+1] (Mine has no bar-index param — it always
 *     verdicts at data.length-1, batch-synthetic-state-miner.ts:558)
 *   - run the REAL Mine engine (runPreparedBatchSyntheticStateMiner)
 *   - record the predicted value (expectedForwardReturnPct / oosLiftPct)
 *   - record the REALIZED forward return from the full (unsliced) OHLCV at
 *     [N, N+horizon], signed by the verdict direction (long→+1, short→-1)
 *
 * Then reports rank IC of predicted-vs-realized, hit rate by direction,
 * confidence calibration, and lift-vs-realized correlation. A config whose
 * Mine output correlates with realized return is a good config; one that
 * doesn't is bad. Run once per config to compare.
 *
 * Single-use diagnostic (AGENTS rule 2). No lib code, no tests, no UI.
 *
 * Usage:
 *   npm run diagnose:mine-prediction
 *   npm run diagnose:mine-prediction -- --assets AAPL,MRK,MU --horizons 12,24
 *   npm run diagnose:mine-prediction -- --strategy <key> --params '{"x":1}' \
 *     --backtest-settings '{"exitStrategyOverrideEnabled":true,"exitStrategyKey":"...","disableSignalExits":true}'
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { BacktestSettings, OHLCVData, StrategyParams } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import { strategies } from "../lib/strategies/library";
import { executeBacktest } from "../lib/backtest-executor";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { parseOhlcvBars } from "./lib/ohlcv-file";
import { buildSyntheticPairDataset } from "./lib/synthetic-pair";
import { toPositiveInt } from "./lib/cli-args";
import {
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    runPreparedBatchSyntheticStateMiner,
    type BatchSyntheticAssetVerdict,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticPreparedPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "../lib/batch-backtest/batch-synthetic-state-miner";

// ============================================================================
// CLI
// ============================================================================

interface CliOptions {
    interval: string;
    assets: string[];
    pairAssets: string[];
    strategyKey: string;
    params: StrategyParams;
    backtestSettings: Record<string, unknown>;
    horizons: number[];
    sampleBars: number;
    sampleStep: number;
    lagBars: number;
    minSamples: number;
    minOosSamples: number;
    neighborMin: number;
    neighborMax: number;
    /** Inclusive verdict-bar window (unix seconds). NaN = unbounded. */
    sampleFromSec: number;
    sampleToSec: number;
    outPath: string | null;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx >= 0 ? argv[idx + 1] : undefined;
    };
    const parseJson = (flag: string, fallback: string): unknown => {
        const raw = get(flag);
        if (!raw) return JSON.parse(fallback);
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error(`${flag} must be JSON, got: ${raw}`);
        }
    };
    const paramsRaw = parseJson("--params", "{}");
    const params: StrategyParams = {};
    if (paramsRaw && typeof paramsRaw === "object" && !Array.isArray(paramsRaw)) {
        for (const [k, v] of Object.entries(paramsRaw as Record<string, unknown>)) {
            const n = Number(v);
            if (Number.isFinite(n)) params[k] = n;
        }
    }
    // Backtest settings: read from a file (--backtest-settings-file path.json)
    // to avoid typing a 30-field JSON blob on the command line, OR inline
    // (--backtest-settings '{...}'). File wins if both supplied.
    const settingsFilePath = get("--backtest-settings-file");
    let backtestSettings: Record<string, unknown>;
    if (settingsFilePath) {
        const text = fs.readFileSync(settingsFilePath, "utf8");
        backtestSettings = JSON.parse(text);
    } else {
        backtestSettings = parseJson("--backtest-settings", "{}") as Record<string, unknown>;
    }
    // Date-range filter: --sample-from YYYY-MM-DD --sample-to YYYY-MM-DD.
    // Interpreted as the verdict bar's date (inclusive). NaN = unbounded.
    const parseDateSec = (flag: string): number => {
        const raw = get(flag);
        if (!raw) return Number.NaN;
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms)) throw new Error(`${flag} must be YYYY-MM-DD (or ISO), got: ${raw}`);
        return Math.floor(ms / 1000);
    };
    const horizonsRaw = get("--horizons") ?? "12,24,48";
    const horizons = horizonsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1);
    if (horizons.length === 0) throw new Error("--horizons must contain at least one positive integer");
    const assets = (get("--assets") ?? "AAPL,MRK,MU,NVDA,DIS").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const pairAssets = (get("--pair-assets") ?? assets.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    return {
        interval: get("--interval") ?? "4h",
        assets,
        pairAssets,
        strategyKey: get("--strategy") ?? "return_sign_streak_fade",
        params,
        backtestSettings,
        horizons,
        sampleBars: toPositiveInt(get("--sample-bars"), 80, 5),
        sampleStep: toPositiveInt(get("--sample-step"), 20, 1),
        lagBars: toPositiveInt(get("--lag-bars"), 3, 0),
        minSamples: toPositiveInt(get("--min-samples"), 12, 1),
        minOosSamples: toPositiveInt(get("--min-oos-samples"), 4, 1),
        neighborMin: toPositiveInt(get("--neighbor-min"), 4, 1),
        neighborMax: toPositiveInt(get("--neighbor-max"), 24, 1),
        sampleFromSec: parseDateSec("--sample-from"),
        sampleToSec: parseDateSec("--sample-to"),
        outPath: get("--out") ?? null,
    };
}

// ============================================================================
// CSV loading (inline — IBKR CSV format: time,open,high,low,close,volume)
// ============================================================================

function readIbkrCsv(filePath: string): unknown[] {
    const text = fs.readFileSync(filePath, "utf8");
    const rows: unknown[] = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().startsWith("time,")) continue;
        const cols = trimmed.split(",");
        if (cols.length < 5) continue;
        rows.push([cols[0], Number(cols[1]), Number(cols[2]), Number(cols[3]), Number(cols[4]), cols.length > 5 ? Number(cols[5]) : 0]);
    }
    return rows;
}

function loadAsset(assetDir: string, interval: string, assets: string[]): Map<string, OHLCVData[]> {
    const intervalDir = path.join(assetDir, interval);
    if (!fs.existsSync(intervalDir)) {
        throw new Error(`No CSV directory at ${intervalDir} for interval "${interval}"`);
    }
    const out = new Map<string, OHLCVData[]>();
    for (const asset of assets) {
        const full = path.join(intervalDir, `${asset}.csv`);
        if (!fs.existsSync(full)) {
            process.stderr.write(`[diagnose-mine] WARN: missing ${full}, skipping ${asset}\n`);
            continue;
        }
        const bars = trimToClosedCandles(parseOhlcvBars(readIbkrCsv(full)), interval);
        if (bars.length > 0) out.set(asset, bars);
    }
    return out;
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

function aggregate(values: number[]): { mean: number; tStat: number; n: number } {
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

// ============================================================================
// Pair backtest (uses executeBacktest to honor the user's real exit overlay)
// ============================================================================

async function buildPairArtifacts(
    opts: CliOptions,
    assetData: Map<string, OHLCVData[]>,
): Promise<BatchSyntheticPairArtifact[]> {
    const strategy = strategies[opts.strategyKey];
    if (!strategy) {
        throw new Error(`Unknown strategy key: ${opts.strategyKey}. Available: ${Object.keys(strategies).slice(0, 20).join(", ")}...`);
    }
    const params = strategy.normalizeParams ? strategy.normalizeParams({ ...strategy.defaultParams, ...opts.params }) : { ...strategy.defaultParams, ...opts.params };
    const capitalSettings: CapitalSettings = {
        initialCapital: 10000,
        positionSize: 100,
        commission: 0.04,
        sizingMode: "percent",
        fixedTradeAmount: 1000,
    };
    const artifacts: BatchSyntheticPairArtifact[] = [];
    const assets = opts.pairAssets;
    for (let i = 0; i < assets.length; i += 1) {
        for (let j = i + 1; j < assets.length; j += 1) {
            const base = assets[i]!;
            const quote = assets[j]!;
            const baseData = assetData.get(base);
            const quoteData = assetData.get(quote);
            if (!baseData || !quoteData) continue;
            let dataset;
            try {
                dataset = buildSyntheticPairDataset({ base: baseData, quote: quoteData, interval: opts.interval });
            } catch {
                continue;
            }
            if (dataset.bars.length < 100) continue;
            // Use executeBacktest (not runBacktest) so the exit-strategy override,
            // disableSignalExits, and adaptive take-profit in backtestSettings are
            // honored — same path the real batch runner uses. This makes the pair
            // trades match what production would have produced.
            let output;
            try {
                output = await executeBacktest({
                    ohlcvData: dataset.bars,
                    interval: opts.interval,
                    strategyKey: opts.strategyKey,
                    strategy,
                    strategyParams: params,
                    backtestSettings: opts.backtestSettings as BacktestSettings,
                    capitalSettings,
                    context: {
                        nowSec: Math.floor(Date.now() / 1000),
                        blockRange: null,
                        annotatePolymarket: false,
                        engineMode: "typescript",
                        useRustEnginePreference: false,
                    },
                    backtestRunOptions: { omitEquityCurve: true, skipResultPostProcessing: true },
                });
            } catch (err) {
                process.stderr.write(`[diagnose-mine] pair ${base}+${quote} backtest failed: ${(err as Error).message}\n`);
                continue;
            }
            if (!output.result.trades || output.result.trades.length === 0) continue;
            artifacts.push({
                symbol: `${base}+${quote}`,
                baseAsset: base,
                quoteAsset: quote,
                data: dataset.bars,
                signals: output.signals,
                result: output.result,
            });
        }
    }
    return artifacts;
}

// ============================================================================
// Sampled verdict collection
// ============================================================================

interface VerdictSample {
    asset: string;
    barN: number;
    direction: "long" | "short" | null;
    confidence: string;
    predicted: number | null; // expectedForwardReturnPct
    oosLift: number | null;   // oosLiftPct
    longestPredicted: number | null;
    analogCount: number;
    oosCount: number;
    realized: Map<number, number>; // horizon -> signed forward return
}

/**
 * Slide backward through the asset's history, slice to [:N+1], run Mine, and
 * record predicted vs realized. Mine always verdicts at data.length-1
 * (batch-synthetic-state-miner.ts:558), so slicing is the only way to verdict
 * at a historical bar.
 *
 * Pairs are prepared ONCE and reused across all bars (the prepare cost — ATR
 * index, open-trade adverse-ATR scan — is the dominant per-call expense).
 * Pair data past bar N has minor leakage into auto-horizons/adverse-ATR but
 * NOT into the current-snapshot lookup (which is bar-N-bounded by timeKey).
 * Documented tradeoff for the 10-100x speedup.
 */
function collectVerdictSamples(
    opts: CliOptions,
    asset: string,
    fullData: OHLCVData[],
    preparedPairs: BatchSyntheticPreparedPairArtifact[],
    symbol: string,
): VerdictSample[] {
    const samples: VerdictSample[] = [];
    const longestH = opts.horizons[opts.horizons.length - 1]!;
    // Need enough history for Mine to find analogs AND for the realized label
    // to have fully elapsed. Start from the most recent bar where horizon has
    // elapsed, stride backward.
    const maxN = fullData.length - 1 - longestH;
    const minN = Math.max(opts.horizons[0]! * 4, 200); // Mine needs enough candidates
    if (maxN <= minN) return samples;

    const targetSymbol = symbol;
    let collected = 0;
    for (let N = maxN; N > minN && collected < opts.sampleBars; N -= opts.sampleStep) {
        // Date-range filter: skip bars whose verdict time is outside the window.
        const t = Number(fullData[N]!.time);
        if (!Number.isFinite(t)) continue;
        if (Number.isFinite(opts.sampleFromSec) && t < opts.sampleFromSec) continue;
        if (Number.isFinite(opts.sampleToSec) && t > opts.sampleToSec) continue;
        const sliced = fullData.slice(0, N + 1);
        const preparedTargets = prepareBatchSyntheticTargetArtifacts([
            { asset, symbol: targetSymbol, data: sliced } satisfies BatchSyntheticTargetArtifact,
        ]);
        if (preparedTargets.length === 0) continue;

        let result;
        try {
            result = runPreparedBatchSyntheticStateMiner({
                interval: opts.interval,
                targets: preparedTargets,
                artifacts: preparedPairs,
                options: {
                    horizons: opts.horizons,
                    autoHorizons: false, // pinned; label length must be constant across bars
                    lagBars: opts.lagBars,
                    minSamples: opts.minSamples,
                    minOosSamples: opts.minOosSamples,
                    neighborCountMin: opts.neighborMin,
                    neighborCountMax: opts.neighborMax,
                },
            });
        } catch (err) {
            process.stderr.write(`[diagnose-mine] mine failed at ${asset} bar ${N}: ${(err as Error).message}\n`);
            continue;
        }

        const verdict: BatchSyntheticAssetVerdict | undefined = result.verdicts.find((v) => v.asset === asset || v.asset === asset.toUpperCase());
        if (!verdict) {
            // Mine produced no verdict for this asset at this bar — record as
            // a refusal (still information: Mine declining to call).
            samples.push({
                asset, barN: N, direction: null, confidence: "none",
                predicted: null, oosLift: null, longestPredicted: null,
                analogCount: 0, oosCount: 0,
                realized: computeRealized(fullData, N, opts.horizons),
            });
            collected += 1;
            continue;
        }

        // Realized forward return at each horizon, signed by verdict direction.
        // A correct SHORT on a falling asset scores positive (following the
        // verdict would have made money).
        const realized = computeRealized(fullData, N, opts.horizons, verdict.direction);
        samples.push({
            asset, barN: N,
            direction: verdict.direction,
            confidence: verdict.confidence,
            predicted: verdict.evidence.expectedForwardReturnPct,
            oosLift: verdict.evidence.oosLiftPct,
            longestPredicted: verdict.evidence.longestOosForwardReturnPct,
            analogCount: verdict.evidence.analogCount,
            oosCount: verdict.evidence.oosCount,
            realized,
        });
        collected += 1;
    }
    return samples;
}

function computeRealized(
    fullData: OHLCVData[],
    N: number,
    horizons: number[],
    direction?: "long" | "short" | null,
): Map<number, number> {
    const out = new Map<number, number>();
    const sign = direction === "short" ? -1 : 1; // long/null → +1 (unsigned = raw drift)
    const entryClose = fullData[N]!.close;
    for (const h of horizons) {
        const exitIdx = N + h;
        if (exitIdx >= fullData.length) {
            out.set(h, Number.NaN);
            continue;
        }
        const exitClose = fullData[exitIdx]!.close;
        if (!(entryClose > 0) || !Number.isFinite(exitClose)) {
            out.set(h, Number.NaN);
            continue;
        }
        out.set(h, sign * (exitClose / entryClose - 1));
    }
    return out;
}

// ============================================================================
// Report
// ============================================================================

function buildReport(opts: CliOptions, allSamples: VerdictSample[], pairCount: number): string[] {
    const lines: string[] = [];
    const windowTag = (() => {
        const from = Number.isFinite(opts.sampleFromSec) ? new Date(opts.sampleFromSec * 1000).toISOString().slice(0, 10) : null;
        const to = Number.isFinite(opts.sampleToSec) ? new Date(opts.sampleToSec * 1000).toISOString().slice(0, 10) : null;
        if (!from && !to) return "";
        if (from && to) return ` window=${from}..${to}`;
        if (from) return ` window=${from}..`;
        return ` window=..${to}`;
    })();
    lines.push(
        `MINE_PRED | strategy=${opts.strategyKey} interval=${opts.interval} assets=${opts.assets.length} pairs=${pairCount} samples=${allSamples.length} horizons=${opts.horizons.join(",")}${windowTag}`,
    );
    lines.push(
        `MINE_PRED | NOTE: rank_IC (predicted-vs-realized) is the primary score; hit_rate is per-call accuracy; realized is signed by verdict direction`,
    );

    if (allSamples.length === 0) {
        lines.push("MINE_PRED | no samples collected (check asset data depth, sample-bars, horizons)");
        return lines;
    }

    // 1. Rank IC of predicted vs realized, per horizon (primary score).
    const icParts: string[] = [];
    for (const h of opts.horizons) {
        const predicted: number[] = [];
        const realized: number[] = [];
        for (const s of allSamples) {
            if (s.predicted === null) continue;
            const r = s.realized.get(h);
            if (r === undefined || !Number.isFinite(r)) continue;
            predicted.push(s.predicted / 100); // pct → fraction
            realized.push(r);
        }
        const ic = spearman(predicted, realized);
        // t-stat from per-asset-bar observations (approximate; not per-bar IR).
        const agg = aggregate(predicted.map((p, i) => {
            const r = realized[i]!;
            // Fisher z-transform would be more correct; simple approximation:
            // treat each observation's contribution via realized rank match.
            return p > 0 === r > 0 ? 1 : 0; // direction agreement proxy
        }));
        icParts.push(`h=${h} IC=${fmt(ic)} n=${predicted.length} dirAgree=${fmtPct(agg.mean)}`);
    }
    lines.push(`RANK_IC  | ${icParts.join(" | ")}`);

    // 2. Hit rate by direction at the primary (shortest) horizon.
    const primaryH = opts.horizons[0]!;
    const byDir = { long: [] as number[], short: [] as number[], none: [] as number[] };
    for (const s of allSamples) {
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        const key = s.direction ?? "none";
        if (key === "long") byDir.long.push(r);
        else if (key === "short") byDir.short.push(r);
        else byDir.none.push(r);
    }
    const hitCi = (arr: number[]) => {
        if (arr.length === 0) return { p: Number.NaN, lower: Number.NaN, upper: Number.NaN, n: 0, mean: Number.NaN };
        const hits = arr.filter((r) => r > 0).length;
        return { ...wilson(hits, arr.length), n: arr.length, mean: arr.reduce((a, b) => a + b, 0) / arr.length };
    };
    const longCi = hitCi(byDir.long);
    const shortCi = hitCi(byDir.short);
    const noneCi = hitCi(byDir.none);
    const total = longCi.n + shortCi.n + noneCi.n;
    const refusalRate = total > 0 ? noneCi.n / total : 0;
    lines.push(
        `HIT_RATE | h=${primaryH} LONG hit=${fmtPct(longCi.p)} CI[${fmtPct(longCi.lower)},${fmtPct(longCi.upper)}] n=${longCi.n} meanRet=${fmt(longCi.mean * 100, 2)}% | SHORT hit=${fmtPct(shortCi.p)} CI[${fmtPct(shortCi.lower)},${fmtPct(shortCi.upper)}] n=${shortCi.n} meanRet=${fmt(shortCi.mean * 100, 2)}% | INCONCLUSIVE n=${noneCi.n} (refusal ${fmtPct(refusalRate)})`,
    );

    // 3. Edge vs no-edge: does Mine selecting a direction beat refusing?
    // If LONG/SHORT mean returns are materially above INCONCLUSIVE, Mine is
    // adding selection value. If they're all ~equal, Mine adds nothing.
    const baselineDrift = noneCi.mean;
    const longEdge = Number.isFinite(longCi.mean) && Number.isFinite(baselineDrift) ? longCi.mean - baselineDrift : Number.NaN;
    const shortEdge = Number.isFinite(shortCi.mean) && Number.isFinite(baselineDrift) ? shortCi.mean - baselineDrift : Number.NaN;
    lines.push(
        `EDGE     | h=${primaryH} LONG edge vs inconclusive=${fmt(longEdge * 100, 2)}% | SHORT edge=${fmt(shortEdge * 100, 2)}% | inconclusive-bar passive-long drift=${fmt(baselineDrift * 100, 2)}% (NOT cash; direction=null defaults to long-sign)`,
    );

    // 4. Confidence calibration at primary horizon.
    const byConf: Record<string, number[]> = { high: [], medium: [], low: [], none: [] };
    for (const s of allSamples) {
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        const key = byConf[s.confidence] ? s.confidence : "none";
        byConf[key]!.push(r);
    }
    const confParts = (["high", "medium", "low", "none"] as const).map((c) => {
        const arr = byConf[c]!;
        const ci = hitCi(arr);
        return `${c} hit=${fmtPct(ci.p)} n=${arr.length}`;
    });
    lines.push(`CALIB    | h=${primaryH} ${confParts.join(" | ")} (if high does not beat low, confidence label is meaningless)`);

    // 5. Lift-vs-realized correlation: does the analog oosLiftPct track reality?
    // This is the direct test of whether Portfolio Fit's edge% (which is
    // oosLiftPct re-labelled per the audit) is grounded.
    const liftParts: string[] = [];
    for (const h of opts.horizons) {
        const lifts: number[] = [];
        const real: number[] = [];
        for (const s of allSamples) {
            if (s.oosLift === null) continue;
            const r = s.realized.get(h);
            if (r === undefined || !Number.isFinite(r)) continue;
            lifts.push(s.oosLift / 100);
            real.push(r);
        }
        const corr = pearson(lifts, real);
        liftParts.push(`h=${h} corr=${fmt(corr)} n=${lifts.length}`);
    }
    lines.push(`LIFT_COR | ${liftParts.join(" | ")} (corr ~0 => Portfolio Fit edge% is ungrounded)`);

    // 6. Per-asset breakdown at primary horizon.
    const byAsset = new Map<string, { pred: number[]; real: number[] }>();
    for (const s of allSamples) {
        if (s.predicted === null) continue;
        const r = s.realized.get(primaryH);
        if (r === undefined || !Number.isFinite(r)) continue;
        const entry = byAsset.get(s.asset) ?? { pred: [], real: [] };
        entry.pred.push(s.predicted / 100);
        entry.real.push(r);
        byAsset.set(s.asset, entry);
    }
    const assetParts: string[] = [];
    for (const [asset, { pred, real }] of byAsset) {
        const ic = spearman(pred, real);
        const agg = aggregate(pred.map((p, i) => (p > 0 === real[i]! > 0 ? 1 : 0)));
        assetParts.push(`${asset} IC=${fmt(ic)} dirAgree=${fmtPct(agg.mean)} n=${pred.length}`);
    }
    assetParts.sort();
    lines.push(`PER_ASSET| h=${primaryH} ${assetParts.join(" | ")}`);

    // 7. Verdict + caveats.
    // Primary: does the longest-horizon IC clear |t|>=2? (Approximate via
    // aggregation of direction-agreement across samples.)
    const caveats: string[] = [];
    const primaryIc = (() => {
        const pred: number[] = [];
        const real: number[] = [];
        for (const s of allSamples) {
            if (s.predicted === null) continue;
            const r = s.realized.get(primaryH);
            if (r === undefined || !Number.isFinite(r)) continue;
            pred.push(s.predicted / 100);
            real.push(r);
        }
        return { ic: spearman(pred, real), n: pred.length };
    })();
    const longestH = opts.horizons[opts.horizons.length - 1]!;
    const longestIc = (() => {
        const pred: number[] = [];
        const real: number[] = [];
        for (const s of allSamples) {
            if (s.longestPredicted === null) continue;
            const r = s.realized.get(longestH);
            if (r === undefined || !Number.isFinite(r)) continue;
            pred.push(s.longestPredicted / 100);
            real.push(r);
        }
        return { ic: spearman(pred, real), n: pred.length };
    })();

    // Verdict is anchored to the PRIMARY horizon (the shortest, which is what
    // you'd actually trade on). Sign matters: a negative primary IC means Mine
    // is counter-predictive at the horizon that matters, even if a longer
    // horizon shows positive IC (longer horizons are noisier and less actionable).
    let verdict: string;
    const pIc = primaryIc.ic;
    if (!Number.isFinite(pIc)) {
        verdict = `NO_EDGE: primary IC undefined (n too small).`;
    } else if (pIc <= -0.03) {
        verdict = `ANTI: primary h=${primaryH} IC=${fmt(pIc)} (n=${primaryIc.n}) — Mine is counter-predictive at the trading horizon. Following it loses.`;
    } else if (pIc < 0.05) {
        verdict = `NO_EDGE: primary h=${primaryH} IC=${fmt(pIc)} (n=${primaryIc.n}) — |IC| < 0.05; Mine predictions do not meaningfully correlate with realized return. (longest h=${longestH} IC=${fmt(longestIc.ic)})`;
    } else {
        verdict = `WEAK_PREDICTIVE: primary h=${primaryH} IC=${fmt(pIc)} (n=${primaryIc.n}) — IC > 0.05. Check CALIB and EDGE lines for whether it is tradeable. (longest h=${longestH} IC=${fmt(longestIc.ic)})`;
    }

    // Caveats
    if (Number.isFinite(longCi.mean) && Number.isFinite(noneCi.mean) && longCi.mean - noneCi.mean < 0.005) {
        const diff = (longCi.mean - noneCi.mean) * 100;
        caveats.push(`LONG edge over inconclusive-bars is only ${fmt(diff, 2)}% (< 0.5% meaningful-edge threshold) — Mine's LONG selection adds little beyond passive-long drift`);
    }
    const highArr = byConf.high!;
    const lowArr = byConf.low!;
    if (highArr.length > 0 && lowArr.length > 0) {
        const highHit = highArr.filter((r) => r > 0).length / highArr.length;
        const lowHit = lowArr.filter((r) => r > 0).length / lowArr.length;
        if (highHit < lowHit + 0.02) {
            caveats.push(`confidence not calibrated: high hit=${fmtPct(highHit)} does not beat low hit=${fmtPct(lowHit)}`);
        }
    }
    const liftCorrPrimary = (() => {
        const lifts: number[] = []; const real: number[] = [];
        for (const s of allSamples) {
            if (s.oosLift === null) continue;
            const r = s.realized.get(primaryH);
            if (r === undefined || !Number.isFinite(r)) continue;
            lifts.push(s.oosLift / 100); real.push(r);
        }
        return pearson(lifts, real);
    })();
    if (Number.isFinite(liftCorrPrimary) && Math.abs(liftCorrPrimary) < 0.05) {
        caveats.push(`oosLiftPct uncorrelated with realized (corr=${fmt(liftCorrPrimary)}) — Portfolio Fit edge% is ungrounded`);
    }
    if (refusalRate > 0.5) {
        caveats.push(`high refusal rate ${fmtPct(refusalRate)} — Mine declines to verdict on most samples, small effective n`);
    }
    if (caveats.length > 0) lines.push(`CAVEAT   | ${caveats.join(" | ")}`);
    lines.push(`VERDICT  | ${verdict}`);

    return lines;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const repoRoot = process.cwd();
    const assetDir = path.join(repoRoot, "price-data", "ibkr", "csv");

    process.stderr.write(`[diagnose-mine] loading ${opts.pairAssets.length} assets from ${assetDir}/${opts.interval} ...\n`);
    const assetData = loadAsset(assetDir, opts.interval, opts.pairAssets);
    if (assetData.size < 2) {
        throw new Error(`Need at least 2 assets with data; loaded ${assetData.size}. Check price-data/ibkr/csv/${opts.interval}/`);
    }
    process.stderr.write(`[diagnose-mine] loaded ${assetData.size} assets\n`);

    process.stderr.write(`[diagnose-mine] running ${assetData.size * (assetData.size - 1) / 2} pair backtests via executeBacktest (honors exit overlay)...\n`);
    const pairArtifacts = await buildPairArtifacts(opts, assetData);
    process.stderr.write(`[diagnose-mine] pairs with trades: ${pairArtifacts.length}\n`);
    if (pairArtifacts.length === 0) {
        throw new Error("No pair backtests produced trades. Check strategy key/params/backtest-settings.");
    }

    process.stderr.write(`[diagnose-mine] preparing pairs once (ATR/trade/signal indexes)...\n`);
    const preparedPairs = prepareBatchSyntheticPairArtifacts(pairArtifacts);

    const allSamples: VerdictSample[] = [];
    for (const asset of opts.assets) {
        const fullData = assetData.get(asset);
        if (!fullData) {
            process.stderr.write(`[diagnose-mine] WARN: no data for target asset ${asset}, skipping\n`);
            continue;
        }
        process.stderr.write(`[diagnose-mine] sliding ${asset} (${fullData.length} bars, sampling ${opts.sampleBars} bars every ${opts.sampleStep})...\n`);
        const symbol = `${asset}USDT`; // Mine resolves target via resolveBatchSyntheticTargetSymbol
        const samples = collectVerdictSamples(opts, asset, fullData, preparedPairs, symbol);
        allSamples.push(...samples);
        process.stderr.write(`[diagnose-mine]   ${asset}: ${samples.length} verdict samples\n`);
    }

    if (allSamples.length === 0) {
        throw new Error("No verdict samples collected. Check --sample-bars, --horizons, and asset data depth.");
    }

    const reportLines = buildReport(opts, allSamples, pairArtifacts.length);
    const report = reportLines.join("\n");
    if (opts.outPath) {
        fs.writeFileSync(opts.outPath, report + "\n", "utf8");
        process.stderr.write(`[diagnose-mine] report written to ${opts.outPath}\n`);
    }
    process.stdout.write(report + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error("[diagnose-mine] fatal:", error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}
