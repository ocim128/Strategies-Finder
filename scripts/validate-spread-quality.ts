/**
 * Phase 0: Walk-forward validation of spread-quality metrics.
 *
 * Reads batch artifacts from the temp directory (v8-serialized .bin files
 * written by the server during a Batch Run). Splits each pair's ratio
 * history into 6-month train / 3-month test folds. Computes ADF + half-life
 * on each train fold. Measures OOS P&L from the pair's existing trades
 * whose entryTime falls in the test fold. Correlates train metrics with
 * OOS P&L across pairs.
 *
 * This is a RESEARCH SCRIPT — no UI, no endpoint. Its purpose is to determine
 * whether ADF/half-life metrics predict OOS strategy performance. If they
 * don't, Phase 4 (Fixed-Ratio Diagnostics in the UI) is not built.
 *
 * Usage:
 *   npm run validate:spread-quality
 *   npm run validate:spread-quality -- --fold-train-months 6 --fold-test-months 3
 *
 * Must run while the dev server has batch artifacts on disk (within the
 * 10-minute TTL after a Batch Run). If artifacts expired, re-run Batch then
 * immediately run this script.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";
import { pathToFileURL } from "node:url";
import type { OHLCVData, Trade } from "../lib/types/strategies";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import { toPositiveInt } from "./lib/cli-args";

// ============================================================================
// CLI
// ============================================================================

interface CliOptions {
    foldTrainMonths: number;
    foldTestMonths: number;
    minTestTrades: number;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx >= 0 ? argv[idx + 1] : undefined;
    };
    return {
        foldTrainMonths: toPositiveInt(get("--fold-train-months"), 6, 1),
        foldTestMonths: toPositiveInt(get("--fold-test-months"), 3, 1),
        minTestTrades: toPositiveInt(get("--min-test-trades"), 3, 1),
    };
}

// ============================================================================
// Artifact loading
// ============================================================================

const MINE_ARTIFACT_DIR_PREFIX = "strategies-finder-batch-mine-";

interface LoadedArtifact {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    data: OHLCVData[];
    trades: Trade[];
}

function findLatestArtifactDir(): string | null {
    const tmp = tmpdir();
    const entries = fs.readdirSync(tmp);
    let latest: string | null = null;
    let latestMtime = 0;
    for (const entry of entries) {
        if (!entry.startsWith(MINE_ARTIFACT_DIR_PREFIX)) continue;
        const fullPath = path.join(tmp, entry);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latest = fullPath;
            }
        } catch { /* skip */ }
    }
    return latest;
}

function loadArtifactsFromDir(dir: string): LoadedArtifact[] {
    const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".bin"))
        .sort();
    const artifacts: LoadedArtifact[] = [];
    for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
            const bytes = fs.readFileSync(fullPath);
            const artifact = deserialize(bytes) as BatchSyntheticPairArtifact;
            if (artifact && artifact.data && artifact.data.length > 0 && artifact.result?.trades) {
                artifacts.push({
                    symbol: artifact.symbol,
                    baseAsset: artifact.baseAsset,
                    quoteAsset: artifact.quoteAsset,
                    data: artifact.data,
                    trades: artifact.result.trades,
                });
            }
        } catch { /* skip corrupt file */ }
    }
    return artifacts;
}

// ============================================================================
// Statistics: ADF + half-life
// ============================================================================

/**
 * Augmented Dickey-Fuller test (constant-only, lag-0 for simplicity).
 * Returns the t-statistic for H0: unit root. More negative = more stationary.
 * This is a simplified version sufficient for RANKING pairs relative to each
 * other, not for publication-grade p-values.
 */
function adfTest(logSeries: number[]): { tStat: number } {
    const n = logSeries.length;
    if (n < 20) return { tStat: 0 };
    // Δy_t = α + β·y_{t-1} + ε
    // OLS: regress Δy on y_{t-1} + constant
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const m = n - 1;
    for (let t = 1; t < n; t++) {
        const yPrev = logSeries[t - 1]!;
        const dy = logSeries[t]! - yPrev;
        sumX += yPrev; sumY += dy; sumXY += yPrev * dy; sumXX += yPrev * yPrev;
    }
    const meanX = sumX / m;
    const meanY = sumY / m;
    const Sxx = sumXX - m * meanX * meanX;
    if (Sxx < 1e-12) return { tStat: 0 };
    const Sxy = sumXY - m * meanX * meanY;
    const beta = Sxy / Sxx;
    // Residuals and standard error
    let ssr = 0;
    for (let t = 1; t < n; t++) {
        const yPrev = logSeries[t - 1]!;
        const dy = logSeries[t]!;
        const predicted = meanY + beta * (yPrev - meanX);
        ssr += (dy - predicted) ** 2;
    }
    const se = Math.sqrt(ssr / (m - 2)) / Math.sqrt(Sxx);
    const tStat = se > 0 ? beta / se : 0;
    return { tStat };
}

/**
 * Half-life of mean reversion from AR(1) regression.
 * halfLife = -ln(2) / ln(1 + beta). Returns Infinity if beta >= 0 (not mean-reverting).
 */
function halfLife(logSeries: number[]): number {
    const n = logSeries.length;
    if (n < 20) return Number.POSITIVE_INFINITY;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const m = n - 1;
    for (let t = 1; t < n; t++) {
        const yPrev = logSeries[t - 1]!;
        const dy = logSeries[t]! - yPrev;
        sumX += yPrev; sumY += dy; sumXY += yPrev * dy; sumXX += yPrev * yPrev;
    }
    const meanX = sumX / m;
    const meanY = sumY / m;
    const Sxx = sumXX - m * meanX * meanX;
    if (Sxx < 1e-12) return Number.POSITIVE_INFINITY;
    const beta = (sumXY - m * meanX * meanY) / Sxx;
    const rho = 1 + beta;
    if (rho <= 0 || rho >= 1) return Number.POSITIVE_INFINITY;
    return -Math.log(2) / Math.log(rho);
}

function logRatioSeries(data: OHLCVData[], startIdx: number, endIdx: number): number[] {
    const out: number[] = [];
    for (let i = startIdx; i < endIdx && i < data.length; i++) {
        const c = data[i]!.close;
        if (c > 0) out.push(Math.log(c));
    }
    return out;
}

// ============================================================================
// Spearman rank correlation
// ============================================================================

function rankArray(values: number[]): number[] {
    const idx = values.map((_, i) => i);
    idx.sort((a, b) => values[a]! - values[b]!);
    const ranks = new Array<number>(values.length).fill(0);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && values[idx[j + 1]!] === values[idx[i]!]) j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[idx[k]!] = avg;
        i = j + 1;
    }
    return ranks;
}

function spearman(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length < 3) return Number.NaN;
    const ra = rankArray(a);
    const rb = rankArray(b);
    const n = a.length;
    const ma = ra.reduce((x, y) => x + y, 0) / n;
    const mb = rb.reduce((x, y) => x + y, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
        const da = ra[i]! - ma, db = rb[i]! - mb;
        num += da * db; denA += da * da; denB += db * db;
    }
    if (denA === 0 || denB === 0) return Number.NaN;
    return num / Math.sqrt(denA * denB);
}

// ============================================================================
// Walk-forward fold generation
// ============================================================================

interface Fold {
    trainStartSec: number;
    trainEndSec: number;
    testStartSec: number;
    testEndSec: number;
}

function generateFolds(
    minTimeSec: number,
    maxTimeSec: number,
    trainMonths: number,
    testMonths: number,
): Fold[] {
    const folds: Fold[] = [];
    const monthSec = 30 * 24 * 3600;
    const trainLen = trainMonths * monthSec;
    const testLen = testMonths * monthSec;
    let trainStart = minTimeSec;
    while (trainStart + trainLen + testLen <= maxTimeSec) {
        const trainEnd = trainStart + trainLen;
        const testStart = trainEnd;
        const testEnd = testStart + testLen;
        folds.push({ trainStartSec: trainStart, trainEndSec: trainEnd, testStartSec: testStart, testEndSec: testEnd });
        trainStart = testEnd; // non-overlapping walk-forward
    }
    return folds;
}

// ============================================================================
// Per-fold per-pair analysis
// ============================================================================

interface FoldPairResult {
    symbol: string;
    adfTStat: number;
    hl: number;
    testPnl: number;
    testTrades: number;
}

function analyzePairInFold(
    artifact: LoadedArtifact,
    fold: Fold,
    minTestTrades: number,
): FoldPairResult | null {
    const data = artifact.data;
    // Find index range for train window.
    let trainStartIdx = 0;
    let trainEndIdx = 0;
    for (let i = 0; i < data.length; i++) {
        const t = Number(data[i]!.time);
        if (t < fold.trainStartSec) trainStartIdx = i + 1;
        if (t < fold.trainEndSec) trainEndIdx = i + 1;
    }
    if (trainEndIdx - trainStartIdx < 50) return null;

    // Compute ADF + half-life on train window log-ratio.
    const logSeries = logRatioSeries(data, trainStartIdx, trainEndIdx);
    if (logSeries.length < 50) return null;
    const { tStat: adfTStat } = adfTest(logSeries);
    const hl = halfLife(logSeries);

    // Sum trade PnL in test window.
    let testPnl = 0;
    let testTrades = 0;
    for (const trade of artifact.trades) {
        const entrySec = Number(trade.entryTime);
        if (entrySec >= fold.testStartSec && entrySec < fold.testEndSec) {
            testPnl += trade.pnl;
            testTrades += 1;
        }
    }
    if (testTrades < minTestTrades) return null;

    return { symbol: artifact.symbol, adfTStat, hl, testPnl, testTrades };
}

// ============================================================================
// Report
// ============================================================================

function fmtSigned(x: number, d = 3): string {
    if (!Number.isFinite(x)) return "n/a";
    return `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    const opts = parseArgs(process.argv.slice(2));
    process.stderr.write("[validate] searching for batch artifacts...\n");

    const dir = findLatestArtifactDir();
    if (!dir) {
        console.error("[validate] FATAL: No batch artifact directory found in temp.");
        console.error("[validate] Run a Batch in the dev server, then immediately run this script (10-min TTL).");
        process.exitCode = 1;
        return;
    }
    process.stderr.write(`[validate] found artifact dir: ${dir}\n`);

    const artifacts = loadArtifactsFromDir(dir);
    if (artifacts.length === 0) {
        console.error("[validate] FATAL: No valid artifacts loaded from directory.");
        process.exitCode = 1;
        return;
    }
    process.stderr.write(`[validate] loaded ${artifacts.length} pair artifacts\n`);

    // Determine time range across all pairs.
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const a of artifacts) {
        if (a.data.length === 0) continue;
        minTime = Math.min(minTime, Number(a.data[0]!.time));
        maxTime = Math.max(maxTime, Number(a.data[a.data.length - 1]!.time));
    }
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
        console.error("[validate] FATAL: Cannot determine time range from artifacts.");
        process.exitCode = 1;
        return;
    }
    process.stderr.write(`[validate] time range: ${new Date(minTime * 1000).toISOString().slice(0, 10)} to ${new Date(maxTime * 1000).toISOString().slice(0, 10)}\n`);

    // Generate walk-forward folds.
    const folds = generateFolds(minTime, maxTime, opts.foldTrainMonths, opts.foldTestMonths);
    if (folds.length === 0) {
        console.error("[validate] FATAL: History too short for any fold (need at least train+test months).");
        process.exitCode = 1;
        return;
    }
    process.stderr.write(`[validate] generated ${folds.length} folds (${opts.foldTrainMonths}m train / ${opts.foldTestMonths}m test)\n\n`);

    // Analyze each fold.
    const lines: string[] = [];
    lines.push("SPREAD_VALIDATION | Walk-forward: do ADF + half-life predict OOS P&L?");
    lines.push(`SPREAD_VALIDATION | folds=${folds.length} pairs=${artifacts.length} train=${opts.foldTrainMonths}m test=${opts.foldTestMonths}m minTestTrades=${opts.minTestTrades}`);
    lines.push("");

    let allFoldIcAdf: number[] = [];
    let allFoldIcHl: number[] = [];
    let foldSummaries: string[] = [];

    for (let fi = 0; fi < folds.length; fi++) {
        const fold = folds[fi]!;
        const results: FoldPairResult[] = [];
        for (const artifact of artifacts) {
            const r = analyzePairInFold(artifact, fold, opts.minTestTrades);
            if (r) results.push(r);
        }
        if (results.length < 5) {
            foldSummaries.push(`FOLD ${fi + 1}/${folds.length} | ${new Date(fold.trainStartSec * 1000).toISOString().slice(0, 10)}..${new Date(fold.testEndSec * 1000).toISOString().slice(0, 10)} | pairs=${results.length} (insufficient)`);
            continue;
        }

        // Spearman: ADF t-stat vs test PnL
        const adfVals = results.map((r) => r.adfTStat);
        const pnlVals = results.map((r) => r.testPnl);
        const icAdf = spearman(adfVals, pnlVals);
        if (Number.isFinite(icAdf)) allFoldIcAdf.push(icAdf);

        // Spearman: -halfLife vs test PnL (negative hl = faster reversion = "better")
        const hlVals = results.map((r) => -r.hl);
        const icHl = spearman(hlVals, pnlVals);
        if (Number.isFinite(icHl)) allFoldIcHl.push(icHl);

        // Top vs bottom quantile
        const sortedByAdf = [...results].sort((a, b) => a.adfTStat - b.adfTStat);
        const q = Math.floor(sortedByAdf.length / 4);
        const bottomPnl = sortedByAdf.slice(0, q).reduce((s, r) => s + r.testPnl, 0) / q;
        const topPnl = sortedByAdf.slice(-q).reduce((s, r) => s + r.testPnl, 0) / q;
        const quantSpread = topPnl - bottomPnl;

        const trainDate = new Date(fold.trainStartSec * 1000).toISOString().slice(0, 10);
        const testDate = new Date(fold.testStartSec * 1000).toISOString().slice(0, 10);
        foldSummaries.push(
            `FOLD ${fi + 1}/${folds.length} | train=${trainDate} test=${testDate} | pairs=${results.length} | IC(adf,pnl)=${fmtSigned(icAdf)} | IC(-hl,pnl)=${fmtSigned(icHl)} | top-bottom PnL=${fmtSigned(quantSpread, 0)}`,
        );
    }

    lines.push(...foldSummaries);
    lines.push("");

    // Aggregate across folds.
    const meanIcAdf = allFoldIcAdf.length > 0 ? allFoldIcAdf.reduce((a, b) => a + b, 0) / allFoldIcAdf.length : Number.NaN;
    const meanIcHl = allFoldIcHl.length > 0 ? allFoldIcHl.reduce((a, b) => a + b, 0) / allFoldIcHl.length : Number.NaN;

    // Consistency: how many folds have IC in the same direction as the mean?
    const adfConsistent = allFoldIcAdf.filter((ic) =>
        meanIcAdf > 0 ? ic > 0 : ic < 0
    ).length;
    const hlConsistent = allFoldIcHl.filter((ic) =>
        meanIcHl > 0 ? ic > 0 : ic < 0
    ).length;

    lines.push(`AGGREGATE | IC(adf,pnl) mean=${fmtSigned(meanIcAdf)} consistent=${adfConsistent}/${allFoldIcAdf.length} folds`);
    lines.push(`AGGREGATE | IC(-hl,pnl) mean=${fmtSigned(meanIcHl)} consistent=${hlConsistent}/${allFoldIcHl.length} folds`);

    // Pass/fail criterion (predefined in the plan):
    // - Consistent direction across >=60% of folds
    // - Mean IC is non-trivially different from zero
    const adfPassRate = allFoldIcAdf.length > 0 ? adfConsistent / allFoldIcAdf.length : 0;
    const hlPassRate = allFoldIcHl.length > 0 ? hlConsistent / allFoldIcHl.length : 0;
    const adfPass = adfPassRate >= 0.6 && Math.abs(meanIcAdf) > 0.03;
    const hlPass = hlPassRate >= 0.6 && Math.abs(meanIcHl) > 0.03;

    lines.push("");
    lines.push(`VERDICT  | ADF: ${adfPass ? "PASS" : "FAIL"} (consistency=${(adfPassRate * 100).toFixed(0)}%, meanIC=${fmtSigned(meanIcAdf)})`);
    lines.push(`VERDICT  | Half-life: ${hlPass ? "PASS" : "FAIL"} (consistency=${(hlPassRate * 100).toFixed(0)}%, meanIC=${fmtSigned(meanIcHl)})`);
    lines.push(`VERDICT  | Overall: ${(adfPass || hlPass) ? "Phase 4 justified — metrics show OOS predictive value" : "Phase 4 NOT justified — metrics do not predict OOS P&L. Do not build diagnostic UI."}`);

    process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
