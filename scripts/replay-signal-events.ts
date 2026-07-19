/**
 * Signal-Event Replay — Counterfactual Ranking Diagnostic
 *
 * Tests whether any current-time selection rule can rank the best trade when
 * multiple pairs signal simultaneously. Uses strict causal walk-forward
 * validation with mandatory train/test folds.
 *
 * Usage:
 *   npm run replay:signal-events -- --artifact-dir <path> --execution-model next_open
 *
 * Required flags:
 *   --artifact-dir <path>    Directory containing .bin batch artifacts
 *   --execution-model <m>    Must match batch run: next_open | signal_close
 *
 * Optional flags:
 *   --train-months <N>       Train window months (default 6)
 *   --test-months <N>        Test window months (default 3)
 *   --min-test-events <N>    Minimum events per fold (default 100)
 *   --seed <N>               Random seed (default 42)
 *   --direction <long|short|both>  Direction filter (default both)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { deserialize } from "node:v8";
import { pathToFileURL } from "node:url";
import type { OHLCVData, Signal } from "../lib/types/strategies";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import { toPositiveInt } from "./lib/cli-args";
import { canonicalTimeKey, timeToNumber } from "../lib/strategies/backtest/backtest-utils";

// ============================================================================
// Types
// ============================================================================

export type Direction = "long" | "short";
export type ExecutionModel = "next_open" | "signal_close";
const MIN_USABLE_FOLDS = 3;

export interface SignalCandidate {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    signalTime: number;           // unix seconds
    fillTime: number;             // unix seconds
    exitTime: number;             // unix seconds
    signalTimeKey: string;        // canonical grouping key
    signalBarIndex: number;
    direction: Direction;
    netReturnPct: number;         // pnlPercent (fee-aware)
    entryFeatures: {
        volatilityPct: number | null;
        momentum5: number | null;
        momentum10: number | null;
        momentum20: number | null;
        timeSinceLastExitBars: number | null;
        signalRarity: number | null;
    };
}

export interface SignalEvent {
    signalTimeKey: string;
    signalTime: number;
    candidates: SignalCandidate[];
}

export interface TradeLedgerEntry {
    symbol: string;
    exitTime: number;
    netReturnPct: number;
    signalBarIndex: number;
    exitBarIndex: number;
}

export interface CliOptions {
    artifactDir: string;
    trainMonths: number;
    testMonths: number;
    minTestEvents: number;
    seed: number;
    direction: Direction | "both";
    executionModel: ExecutionModel;
}

export interface Fold {
    trainStartSec: number;
    trainEndSec: number;
    testStartSec: number;
    testEndSec: number;
}

export interface ExclusionCounts {
    mapping: number;
    censored: number;
    boundary: number;
    direction: number;
    corrupt: number;
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx >= 0 ? argv[idx + 1] : undefined;
    };

    const artifactDir = get("--artifact-dir");
    if (!artifactDir) {
        console.error("FATAL: --artifact-dir <path> is required. Explicit path required for reproducibility.");
        process.exit(1);
    }

    const executionModelRaw = get("--execution-model");
    if (executionModelRaw !== "next_open" && executionModelRaw !== "signal_close") {
        console.error("FATAL: --execution-model next_open|signal_close is required. Must match the batch run.");
        process.exit(1);
    }

    const directionRaw = get("--direction") ?? "both";
    if (directionRaw !== "long" && directionRaw !== "short" && directionRaw !== "both") {
        console.error("FATAL: --direction must be long|short|both");
        process.exit(1);
    }

    return {
        artifactDir,
        trainMonths: toPositiveInt(get("--train-months"), 6, 1),
        testMonths: toPositiveInt(get("--test-months"), 3, 1),
        minTestEvents: toPositiveInt(get("--min-test-events"), 100, 1),
        seed: toPositiveInt(get("--seed"), 42, 0),
        direction: directionRaw,
        executionModel: executionModelRaw,
    };
}

// ============================================================================
// Seeded random (mulberry32)
// ============================================================================

export function createSeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ============================================================================
// Binary search for bar index by time
// ============================================================================

function findBarIndexByTime(barTimes: number[], targetTimeSec: number): number {
    let lo = 0;
    let hi = barTimes.length - 1;
    let result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (barTimes[mid]! >= targetTimeSec) {
            result = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    return result >= 0 && barTimes[result] === targetTimeSec ? result : -1;
}

// ============================================================================
// Artifact loading — one at a time, release immediately
// ============================================================================

export function loadArtifactCandidates(
    dir: string,
    executionModel: ExecutionModel,
    directionFilter: Direction | "both",
): { candidates: SignalCandidate[]; exclusions: ExclusionCounts; totalTrades: number } {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Artifact directory does not exist or is not a directory: ${dir}`);
    }
    const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".bin"))
        .sort();
    if (files.length === 0) {
        throw new Error(`No .bin artifacts found in: ${dir}`);
    }

    const candidates: SignalCandidate[] = [];
    const exclusions: ExclusionCounts = { mapping: 0, censored: 0, boundary: 0, direction: 0, corrupt: 0 };
    let totalTrades = 0;

    for (const file of files) {
        const fullPath = path.join(dir, file);
        let artifact: BatchSyntheticPairArtifact;
        try {
            const bytes = fs.readFileSync(fullPath);
            artifact = deserialize(bytes) as BatchSyntheticPairArtifact;
        } catch {
            exclusions.corrupt++;
            continue;
        }

        if (!artifact || !artifact.data || artifact.data.length === 0 || !artifact.result?.trades) {
            exclusions.corrupt++;
            continue;
        }

        const data = artifact.data;
        const trades = artifact.result.trades;
        const signals = artifact.signals ?? [];
        totalTrades += trades.length;

        // Compute bar times as unix seconds for fast lookup (before signal indexing)
        const barTimes: number[] = [];
        let invalidBarTime = false;
        for (let i = 0; i < data.length; i++) {
            const t = timeToNumber(data[i]!.time);
            if (t === null || (i > 0 && t <= barTimes[i - 1]!)) {
                invalidBarTime = true;
                break;
            }
            barTimes.push(t);
        }
        if (invalidBarTime) {
            exclusions.corrupt++;
            continue;
        }

        // Build signal index by barIndex for matching (include signals with barIndex OR time)
        const signalsByBar = new Map<number, Signal[]>();
        for (const sig of signals) {
            if (sig.exitOnly === true) continue;
            let barIdx = sig.barIndex ?? -1;
            if (barIdx < 0) {
                // Fallback: map Signal.time to bar index
                const sigTimeSec = timeToNumber(sig.time);
                if (sigTimeSec === null) continue;
                barIdx = findBarIndexByTime(barTimes, sigTimeSec);
                if (barIdx < 0) continue;
            }
            const existing = signalsByBar.get(barIdx) ?? [];
            existing.push(sig);
            signalsByBar.set(barIdx, existing);
        }

        // Track per-pair signal counts for rarity feature
        const pairSignalBars: number[] = [];
        for (const sig of signals) {
            if (sig.exitOnly === true) continue;
            let barIdx = sig.barIndex ?? -1;
            if (barIdx < 0) {
                const sigTimeSec = timeToNumber(sig.time);
                if (sigTimeSec === null) continue;
                barIdx = findBarIndexByTime(barTimes, sigTimeSec);
            }
            if (barIdx >= 0) pairSignalBars.push(barIdx);
        }
        pairSignalBars.sort((a, b) => a - b);

        // Track per-pair exited trades for causal history
        const exitedTrades: Array<{ exitBarIndex: number; exitTime: number }> = [];

        // Group trades by entry identity to handle partial exits
        // Key: entryTime + entryPrice + type (one real entry can produce multiple Trade records)
        const entryGroups = new Map<string, typeof trades>();
        for (const trade of trades) {
            const entryTimeSec = timeToNumber(trade.entryTime);
            if (entryTimeSec === null) {
                exclusions.mapping++;
                continue;
            }
            const key = `${entryTimeSec}|${trade.entryPrice}|${trade.type}`;
            const existing = entryGroups.get(key) ?? [];
            existing.push(trade);
            entryGroups.set(key, existing);
        }

        for (const [_key, groupTrades] of entryGroups) {
            // Aggregate partial exits into one candidate
            const firstTrade = groupTrades[0]!;
            const entryTimeSec = timeToNumber(firstTrade.entryTime);
            if (entryTimeSec === null) {
                exclusions.mapping++;
                continue;
            }

            // An end-of-data remainder means the entry's full outcome is unknown,
            // even when an earlier partial exit realized some P&L.
            if (groupTrades.some((t) => t.exitReason === "end_of_data")) {
                exclusions.censored++;
                continue;
            }

            // Direction filter
            if (directionFilter !== "both" && firstTrade.type !== directionFilter) {
                exclusions.direction++;
                continue;
            }

            // Find fill bar index using binary search
            const fillBarIndex = findBarIndexByTime(barTimes, entryTimeSec);
            if (fillBarIndex < 0) {
                exclusions.mapping++;
                continue;
            }

            // Derive signal bar from execution model
            const shift = executionModel === "signal_close" ? 0 : 1;
            const signalBarIndex = fillBarIndex - shift;
            if (signalBarIndex < 0) {
                exclusions.mapping++;
                continue;
            }

            // Match exactly one primary signal on the decision bar
            const entrySignalType: Signal["type"] = firstTrade.type === "long" ? "buy" : "sell";
            const matchedSignals = (signalsByBar.get(signalBarIndex) ?? [])
                .filter((signal) => signal.type === entrySignalType);
            if (matchedSignals.length !== 1) {
                exclusions.mapping++;
                continue;
            }
            const matchedSignal = matchedSignals[0]!;

            const signalTimeSec = timeToNumber(matchedSignal.time);
            if (signalTimeSec === null) {
                exclusions.mapping++;
                continue;
            }

            // Compute aggregate exit time and netReturnPct from partial exits
            let totalPnl = 0;
            let totalEntryValue = 0;
            let lastExitTimeSec = 0;
            let hasValidExit = false;
            let invalidExit = false;
            for (const trade of groupTrades) {
                const exitTimeSec = timeToNumber(trade.exitTime);
                if (
                    exitTimeSec === null
                    || !Number.isFinite(trade.pnl)
                    || !Number.isFinite(trade.size)
                    || !(trade.size > 0)
                ) {
                    invalidExit = true;
                    break;
                }
                totalPnl += trade.pnl;
                totalEntryValue += trade.entryPrice * trade.size;
                lastExitTimeSec = Math.max(lastExitTimeSec, exitTimeSec);
                hasValidExit = true;
            }
            if (invalidExit || !hasValidExit) {
                exclusions.mapping++;
                continue;
            }
            if (!(totalEntryValue > 0)) {
                exclusions.mapping++;
                continue;
            }
            const netReturnPct = (totalPnl / totalEntryValue) * 100;

            // Compute features at signal bar
            const volatilityPct = computeAtrPct(data, signalBarIndex, 14);
            const momentum5 = computeMomentum(data, signalBarIndex, 5);
            const momentum10 = computeMomentum(data, signalBarIndex, 10);
            const momentum20 = computeMomentum(data, signalBarIndex, 20);

            // timeSinceLastExitBars: find last exited trade before this signal
            let timeSinceLastExitBars: number | null = null;
            for (let i = exitedTrades.length - 1; i >= 0; i--) {
                if (exitedTrades[i]!.exitTime < signalTimeSec) {
                    timeSinceLastExitBars = signalBarIndex - exitedTrades[i]!.exitBarIndex;
                    break;
                }
            }

            // signalRarity: 1 / count of prior signals in last 100 bars
            let signalRarity: number | null = null;
            let priorSignalCount = 0;
            for (let i = pairSignalBars.length - 1; i >= 0; i--) {
                const bar = pairSignalBars[i]!;
                if (bar < signalBarIndex && bar >= signalBarIndex - 100) {
                    priorSignalCount++;
                } else if (bar < signalBarIndex - 100) {
                    break;
                }
            }
            if (priorSignalCount > 0) {
                signalRarity = 1 / priorSignalCount;
            }

            candidates.push({
                symbol: artifact.symbol,
                baseAsset: artifact.baseAsset,
                quoteAsset: artifact.quoteAsset,
                signalTime: signalTimeSec,
                fillTime: entryTimeSec,
                exitTime: lastExitTimeSec,
                signalTimeKey: canonicalTimeKey(matchedSignal.time),
                signalBarIndex,
                direction: firstTrade.type,
                netReturnPct,
                entryFeatures: {
                    volatilityPct,
                    momentum5,
                    momentum10,
                    momentum20,
                    timeSinceLastExitBars,
                    signalRarity,
                },
            });

            // Record exit for causal history
            const exitBarIndex = findBarIndexByTime(barTimes, lastExitTimeSec);
            if (exitBarIndex >= 0) {
                exitedTrades.push({ exitBarIndex, exitTime: lastExitTimeSec });
                exitedTrades.sort((a, b) => a.exitTime - b.exitTime);
            }
        }
        // artifact goes out of scope — released
    }

    return { candidates, exclusions, totalTrades };
}

// ============================================================================
// Feature computation
// ============================================================================

function computeAtrPct(data: OHLCVData[], barIndex: number, period: number): number | null {
    if (barIndex < period) return null;
    let sum = 0;
    for (let i = barIndex - period + 1; i <= barIndex; i++) {
        const curr = data[i]!;
        const prev = data[i - 1]!;
        const tr = Math.max(
            curr.high - curr.low,
            Math.abs(curr.high - prev.close),
            Math.abs(curr.low - prev.close),
        );
        sum += tr;
    }
    const atr = sum / period;
    const close = data[barIndex]!.close;
    if (close <= 0) return null;
    return (atr / close) * 100;
}

function computeMomentum(data: OHLCVData[], barIndex: number, lookback: number): number | null {
    if (barIndex < lookback) return null;
    const curr = data[barIndex]!.close;
    const prev = data[barIndex - lookback]!.close;
    if (prev <= 0) return null;
    return ((curr / prev) - 1) * 100;
}

// ============================================================================
// Signal-event grouping
// ============================================================================

export function groupBySignalEvent(candidates: SignalCandidate[]): SignalEvent[] {
    const byKey = new Map<string, SignalCandidate[]>();
    for (const c of candidates) {
        const existing = byKey.get(c.signalTimeKey) ?? [];
        existing.push(c);
        byKey.set(c.signalTimeKey, existing);
    }

    const events: SignalEvent[] = [];
    for (const [key, group] of byKey) {
        if (group.length < 2) continue; // multi-signal only
        events.push({
            signalTimeKey: key,
            signalTime: group[0]!.signalTime,
            candidates: group,
        });
    }
    events.sort((a, b) => a.signalTime - b.signalTime);
    return events;
}

// ============================================================================
// Selection rules
// ============================================================================

export type RuleFn = (
    candidate: SignalCandidate,
    ledger: Map<string, TradeLedgerEntry[]>,
    rng: () => number,
) => number;

interface RuleDef {
    name: string;
    lookback: number | null;
    fn: RuleFn;
}

function getCausalHistory(
    candidate: SignalCandidate,
    ledger: Map<string, TradeLedgerEntry[]>,
): TradeLedgerEntry[] {
    const history = ledger.get(candidate.symbol) ?? [];
    return history.filter((t) => t.exitTime < candidate.signalTime);
}

function recentReturns(history: TradeLedgerEntry[], n: number): number[] {
    const sorted = [...history].sort((a, b) => b.exitTime - a.exitTime);
    return sorted.slice(0, n).map((t) => t.netReturnPct);
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}

const RULES: RuleDef[] = [
    {
        name: "random",
        lookback: null,
        fn: (_c, _h, rng) => rng(),
    },
    {
        name: "recent_return_mean_std_5",
        lookback: 5,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 5);
            if (rets.length < 2) return 0;
            const m = mean(rets);
            const s = stdDev(rets);
            return s > 0 ? m / s : 0;
        },
    },
    {
        name: "recent_return_mean_std_10",
        lookback: 10,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 10);
            if (rets.length < 2) return 0;
            const m = mean(rets);
            const s = stdDev(rets);
            return s > 0 ? m / s : 0;
        },
    },
    {
        name: "recent_return_mean_std_20",
        lookback: 20,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 20);
            if (rets.length < 2) return 0;
            const m = mean(rets);
            const s = stdDev(rets);
            return s > 0 ? m / s : 0;
        },
    },
    {
        name: "recent_winrate_5",
        lookback: 5,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 5);
            if (rets.length === 0) return 0;
            return rets.filter((r) => r > 0).length / rets.length;
        },
    },
    {
        name: "recent_winrate_10",
        lookback: 10,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 10);
            if (rets.length === 0) return 0;
            return rets.filter((r) => r > 0).length / rets.length;
        },
    },
    {
        name: "recent_avg_return_5",
        lookback: 5,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 5);
            return mean(rets);
        },
    },
    {
        name: "recent_avg_return_10",
        lookback: 10,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 10);
            return mean(rets);
        },
    },
    {
        name: "recent_profit_factor_5",
        lookback: 5,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 5);
            if (rets.length === 0) return 0;
            const wins = rets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
            const losses = Math.abs(rets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
            return losses > 0 ? wins / losses : wins > 0 ? 999 : 0;
        },
    },
    {
        name: "recent_profit_factor_10",
        lookback: 10,
        fn: (c, h) => {
            const rets = recentReturns(getCausalHistory(c, h), 10);
            if (rets.length === 0) return 0;
            const wins = rets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
            const losses = Math.abs(rets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
            return losses > 0 ? wins / losses : wins > 0 ? 999 : 0;
        },
    },
    {
        name: "time_since_last_exit",
        lookback: null,
        fn: (c) => c.entryFeatures.timeSinceLastExitBars ?? 0,
    },
    {
        name: "signal_rarity",
        lookback: null,
        fn: (c) => c.entryFeatures.signalRarity ?? 0,
    },
    {
        name: "entry_volatility",
        lookback: null,
        fn: (c) => {
            const v = c.entryFeatures.volatilityPct;
            return v === null ? Number.NEGATIVE_INFINITY : -v; // lower vol = higher score; missing = worst
        },
    },
    {
        name: "momentum_5",
        lookback: 5,
        fn: (c) => c.entryFeatures.momentum5 ?? 0,
    },
    {
        name: "momentum_10",
        lookback: 10,
        fn: (c) => c.entryFeatures.momentum10 ?? 0,
    },
    {
        name: "momentum_20",
        lookback: 20,
        fn: (c) => c.entryFeatures.momentum20 ?? 0,
    },
];

export function scoreCandidateForRule(
    ruleName: string,
    candidate: SignalCandidate,
    ledger: Map<string, TradeLedgerEntry[]> = new Map(),
    rng: () => number = () => 0.5,
): number {
    const rule = RULES.find((candidateRule) => candidateRule.name === ruleName);
    if (!rule) throw new Error(`Unknown replay rule: ${ruleName}`);
    return rule.fn(candidate, ledger, rng);
}

// ============================================================================
// Walk-forward fold generation (rolling train window)
// ============================================================================

export function generateFolds(
    minTimeSec: number,
    maxTimeSec: number,
    trainMonths: number,
    testMonths: number,
): Fold[] {
    const folds: Fold[] = [];
    const addCalendarMonths = (timeSec: number, months: number): number => {
        const source = new Date(timeSec * 1000);
        const targetMonthIndex = source.getUTCMonth() + months;
        const targetYear = source.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
        const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
        const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        return Date.UTC(
            targetYear,
            targetMonth,
            Math.min(source.getUTCDate(), lastTargetDay),
            source.getUTCHours(),
            source.getUTCMinutes(),
            source.getUTCSeconds(),
        ) / 1000;
    };
    let step = 0;
    while (true) {
        const trainStart = addCalendarMonths(minTimeSec, step * testMonths);
        const trainEnd = addCalendarMonths(trainStart, trainMonths);
        const testStart = trainEnd;
        const testEnd = addCalendarMonths(testStart, testMonths);
        if (testEnd > maxTimeSec) break;
        folds.push({ trainStartSec: trainStart, trainEndSec: trainEnd, testStartSec: testStart, testEndSec: testEnd });
        step++;
    }
    return folds;
}

// ============================================================================
// Spearman rank correlation (IC)
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

export function spearman(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length < 2) return Number.NaN;
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
// Evaluation helpers
// ============================================================================

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1]! + sorted[mid]!) / 2
        : sorted[mid]!;
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function selectTopCandidate(
    event: SignalEvent,
    rule: RuleDef,
    ledger: Map<string, TradeLedgerEntry[]>,
    rng: () => number,
): SignalCandidate {
    const scored = event.candidates.map((candidate) => ({
        candidate,
        score: rule.fn(candidate, ledger, rng),
        tieBreak: rng(),
    }));
    scored.sort((a, b) =>
        (b.score - a.score)
        || (b.tieBreak - a.tieBreak)
        || a.candidate.symbol.localeCompare(b.candidate.symbol)
    );
    return scored[0]!.candidate;
}

function evaluateRuleOnEvents(
    events: SignalEvent[],
    rule: RuleDef,
    ledger: Map<string, TradeLedgerEntry[]>,
    rng: () => number,
): number[] {
    return events.map((event) => {
        const selected = selectTopCandidate(event, rule, ledger, rng);
        const eventMean = mean(event.candidates.map((candidate) => candidate.netReturnPct));
        return selected.netReturnPct - eventMean;
    });
}

function blockBootstrapCi(
    foldDeltas: number[][],
    rng: () => number,
): [number, number] {
    if (foldDeltas.length === 0) return [0, 0];
    const bootstrapMeans: number[] = [];
    for (let iteration = 0; iteration < 1000; iteration++) {
        const sample: number[] = [];
        for (let block = 0; block < foldDeltas.length; block++) {
            const index = Math.floor(rng() * foldDeltas.length);
            sample.push(...foldDeltas[index]!);
        }
        bootstrapMeans.push(mean(sample));
    }
    return [percentile(bootstrapMeans, 2.5), percentile(bootstrapMeans, 97.5)];
}

// ============================================================================
// Replay engine
// ============================================================================

export interface ReplayResult {
    lines: string[];
    exclusions: ExclusionCounts;
    eligibleCount: number;
}

export function runReplay(
    candidates: SignalCandidate[],
    opts: CliOptions,
    exclusions: ExclusionCounts,
    totalTrades: number = candidates.length,
): ReplayResult {
    const lines: string[] = [];
    const reportExclusions: ExclusionCounts = { ...exclusions };
    const boundaryExclusions = new Set<string>();

    // Group into signal events
    const events = groupBySignalEvent(candidates);
    const multiSignalEvents = events.length;

    if (multiSignalEvents === 0) {
        lines.push("SIGNAL_REPLAY | 0 multi-signal events — selection rules not testable on this universe");
        return { lines, exclusions: reportExclusions, eligibleCount: candidates.length };
    }

    // Determine time range
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const c of candidates) {
        minTime = Math.min(minTime, c.signalTime);
        maxTime = Math.max(maxTime, c.exitTime);
    }

    const folds = generateFolds(minTime, maxTime, opts.trainMonths, opts.testMonths);
    if (folds.length === 0) {
        lines.push("SIGNAL_REPLAY | History too short for any fold (need at least train+test months)");
        return { lines, exclusions: reportExclusions, eligibleCount: candidates.length };
    }

    // Reserve last fold as holdout
    const rollingFolds = folds.slice(0, -1);
    const holdoutFold = folds[folds.length - 1]!;

    // Build causal ledger: per-symbol sorted list of completed trades
    const ledger = new Map<string, TradeLedgerEntry[]>();
    for (const c of candidates) {
        const existing = ledger.get(c.symbol) ?? [];
        existing.push({
            symbol: c.symbol,
            exitTime: c.exitTime,
            netReturnPct: c.netReturnPct,
            signalBarIndex: c.signalBarIndex,
            exitBarIndex: c.signalBarIndex,
        });
        ledger.set(c.symbol, existing);
    }
    for (const [symbol, entries] of ledger) {
        entries.sort((a, b) => a.exitTime - b.exitTime);
        ledger.set(symbol, entries);
    }

    // Per-fold evaluation
    const rng = createSeededRandom(opts.seed);
    const foldResults: Array<{
        foldIndex: number;
        fold: Fold;
        events: SignalEvent[];
        bestRule: string;
        bestLookback: number | null;
        trainIc: number;
        deltas: number[];
        oracleDeltas: number[];
    }> = [];

    for (let fi = 0; fi < rollingFolds.length; fi++) {
        const fold = rollingFolds[fi]!;

        const trainWindowEvents = events.filter((e) =>
            e.signalTime >= fold.trainStartSec &&
            e.signalTime < fold.trainEndSec
        );
        for (const event of trainWindowEvents) {
            for (const candidate of event.candidates) {
                if (candidate.exitTime >= fold.trainEndSec) {
                    boundaryExclusions.add(`train|${fi}|${event.signalTimeKey}|${candidate.symbol}|${candidate.direction}`);
                }
            }
        }
        const trainEvents = trainWindowEvents.filter((event) =>
            event.candidates.every((candidate) => candidate.exitTime < fold.trainEndSec)
        );

        const testWindowEvents = events.filter((e) =>
            e.signalTime >= fold.testStartSec &&
            e.signalTime < fold.testEndSec
        );
        for (const event of testWindowEvents) {
            for (const candidate of event.candidates) {
                if (candidate.exitTime >= fold.testEndSec) {
                    boundaryExclusions.add(`test|${fi}|${event.signalTimeKey}|${candidate.symbol}|${candidate.direction}`);
                }
            }
        }
        const testEvents = testWindowEvents.filter((event) =>
            event.candidates.every((candidate) => candidate.exitTime < fold.testEndSec)
        );

        if (trainEvents.length < opts.minTestEvents || testEvents.length < opts.minTestEvents) {
            continue; // INSUFFICIENT_DATA for this fold
        }

        // Compute IC for each rule on train using within-event ranking
        let bestRule = "random";
        let bestLookback: number | null = null;
        let bestIc = -Infinity;

        for (const rule of RULES) {
            if (rule.name === "random") continue;
            const eventIcs: number[] = [];

            for (const event of trainEvents) {
                if (event.candidates.length < 2) continue;
                const scores: number[] = [];
                const returns: number[] = [];
                for (const candidate of event.candidates) {
                    const score = rule.fn(candidate, ledger, rng);
                    scores.push(score);
                    returns.push(candidate.netReturnPct);
                }
                const ic = spearman(scores, returns);
                if (Number.isFinite(ic)) eventIcs.push(ic);
            }

            const meanIc = eventIcs.length > 0 ? mean(eventIcs) : Number.NaN;
            if (Number.isFinite(meanIc) && meanIc > bestIc) {
                bestIc = meanIc;
                bestRule = rule.name;
                bestLookback = rule.lookback;
            }
        }

        // Apply best rule on test
        const selectedRule = RULES.find((r) => r.name === bestRule && r.lookback === bestLookback) ?? RULES[0]!;
        const deltas: number[] = [];
        const oracleDeltas: number[] = [];

        for (const event of testEvents) {
            const selected = selectTopCandidate(event, selectedRule, ledger, rng);
            const eventMean = mean(event.candidates.map((c) => c.netReturnPct));
            const delta = selected.netReturnPct - eventMean;
            deltas.push(delta);

            const bestReturn = Math.max(...event.candidates.map((c) => c.netReturnPct));
            oracleDeltas.push(bestReturn - eventMean);
        }

        foldResults.push({
            foldIndex: fi,
            fold,
            events: testEvents,
            bestRule,
            bestLookback,
            trainIc: bestIc,
            deltas,
            oracleDeltas,
        });
    }

    const allDeltas = foldResults.flatMap((f) => f.deltas);
    const allOracleDeltas = foldResults.flatMap((f) => f.oracleDeltas);
    const foldMeanDeltas = foldResults.map((f) => mean(f.deltas));
    const posFolds = foldMeanDeltas.filter((d) => d > 0).length;
    const totalFolds = foldResults.length;
    const [ciLow, ciHigh] = blockBootstrapCi(
        foldResults.map((foldResult) => foldResult.deltas),
        createSeededRandom(opts.seed + 1000),
    );

    // Evaluate every fixed rule on the same OOS folds. These diagnostics are
    // separate from the adaptive walk-forward selector above and can safely
    // choose one frozen rule for the untouched holdout.
    const fixedRuleResults = RULES.map((rule, ruleIndex) => {
        const ruleRng = createSeededRandom(opts.seed + 2000 + ruleIndex * 104729);
        const foldDeltas = foldResults.map((foldResult) =>
            evaluateRuleOnEvents(foldResult.events, rule, ledger, ruleRng)
        );
        const deltas = foldDeltas.flat();
        const [ruleCiLow, ruleCiHigh] = blockBootstrapCi(
            foldDeltas,
            createSeededRandom(opts.seed + 5000 + ruleIndex * 104729),
        );
        return {
            rule,
            deltas,
            foldDeltas,
            meanDelta: mean(deltas),
            medianDelta: median(deltas),
            positiveFolds: foldDeltas.filter((values) => mean(values) > 0).length,
            ciLow: ruleCiLow,
            ciHigh: ruleCiHigh,
        };
    });
    const randomResult = fixedRuleResults.find((result) => result.rule.name === "random")!;

    // Holdout evaluation
    const holdoutWindowEvents = events.filter((e) =>
        e.signalTime >= holdoutFold.testStartSec &&
        e.signalTime < holdoutFold.testEndSec
    );
    for (const event of holdoutWindowEvents) {
        for (const candidate of event.candidates) {
            if (candidate.exitTime >= holdoutFold.testEndSec) {
                boundaryExclusions.add(`holdout|${event.signalTimeKey}|${candidate.symbol}|${candidate.direction}`);
            }
        }
    }
    const holdoutEvents = holdoutWindowEvents.filter((event) =>
        event.candidates.every((candidate) => candidate.exitTime < holdoutFold.testEndSec)
    );
    reportExclusions.boundary += boundaryExclusions.size;

    const holdoutRuleResult = foldResults.length > 0
        ? fixedRuleResults
            .filter((result) => result.rule.name !== "random")
            .sort((a, b) => b.meanDelta - a.meanDelta || a.rule.name.localeCompare(b.rule.name))[0] ?? null
        : null;
    const holdoutRule = holdoutRuleResult?.rule ?? null;

    const holdoutDeltas: number[] = [];
    const holdoutRng = createSeededRandom(opts.seed + 3000);
    if (holdoutRule) {
        holdoutDeltas.push(...evaluateRuleOnEvents(holdoutEvents, holdoutRule, ledger, holdoutRng));
    }

    // Verdict
    const meanDelta = mean(allDeltas);
    const usableFolds = foldResults.filter((f) => f.events.length >= opts.minTestEvents).length;

    let verdict: string;
    if (usableFolds < MIN_USABLE_FOLDS || allDeltas.length < opts.minTestEvents) {
        verdict = "INSUFFICIENT_DATA — too few events for reliable conclusion";
    } else if (meanDelta > 0 && ciLow > 0 && posFolds / totalFolds >= 0.6) {
        verdict = "OOS_EDGE: rule shows reliable signal-event ranking value";
    } else {
        verdict = "NO_OOS_EDGE: no tested rule reliably ranks simultaneous signals better than random";
    }

    // Format report
    const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
    const fmtDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

    lines.push(`SIGNAL_REPLAY | artifact-dir=${opts.artifactDir} pairs=${new Set(candidates.map((c) => c.symbol)).size} trades=${totalTrades} events=${events.length} multi_signal_events=${multiSignalEvents}`);
    lines.push(`SIGNAL_REPLAY | mode=counterfactual-ranking | executionModel=${opts.executionModel} | outcome=netReturnPct | seed=${opts.seed} | folds=${folds.length}`);
    lines.push(`SIGNAL_REPLAY | rolling_folds=${rollingFolds.length} usable_folds=${usableFolds} min_usable_folds=${MIN_USABLE_FOLDS}`);
    lines.push(`SIGNAL_REPLAY | eligible=${candidates.length} excluded_mapping=${reportExclusions.mapping} excluded_boundary=${reportExclusions.boundary} excluded_censored=${reportExclusions.censored} excluded_direction=${reportExclusions.direction} excluded_corrupt=${reportExclusions.corrupt}`);
    lines.push(`SIGNAL_REPLAY | NOTE: ranking diagnostic only. Does not simulate portfolio capacity or capital constraints.`);
    lines.push("");

    for (const fr of foldResults) {
        lines.push(`FOLD ${fr.foldIndex + 1}/${folds.length} | train=${fmtDate(fr.fold.trainStartSec)}..=${fmtDate(fr.fold.trainEndSec)} test=${fmtDate(fr.fold.testStartSec)}..=${fmtDate(fr.fold.testEndSec)} | events=${fr.events.length} | best_train_rule=${fr.bestRule} train_IC=${fr.trainIc.toFixed(3)}`);
    }
    lines.push("");

    lines.push(`OOS_SELECTOR | walk_forward: mean_delta=${fmtPct(meanDelta)} median=${fmtPct(median(allDeltas))} pos_folds=${posFolds}/${totalFolds} bootstrap_CI=[${fmtPct(ciLow)}, ${fmtPct(ciHigh)}]`);
    for (const result of fixedRuleResults) {
        if (result.rule.name === "random") continue;
        lines.push(`OOS_RULE  | ${result.rule.name}: mean_delta=${fmtPct(result.meanDelta)} median=${fmtPct(result.medianDelta)} pos_folds=${result.positiveFolds}/${totalFolds} bootstrap_CI=[${fmtPct(result.ciLow)}, ${fmtPct(result.ciHigh)}]`);
    }
    lines.push(`OOS_RULE  | random:       mean_delta=${fmtPct(randomResult.meanDelta)} median=${fmtPct(randomResult.medianDelta)} pos_folds=${randomResult.positiveFolds}/${totalFolds} bootstrap_CI=[${fmtPct(randomResult.ciLow)}, ${fmtPct(randomResult.ciHigh)}]`);
    lines.push(`OOS_CEIL  | oracle:       mean_delta=${fmtPct(mean(allOracleDeltas))} (upper bound — best possible top-1 selection)`);
    lines.push(`HOLDOUT   | frozen_rule=${holdoutRule?.name ?? "none"} events=${holdoutEvents.length} mean_delta=${fmtPct(mean(holdoutDeltas))} median=${fmtPct(median(holdoutDeltas))}`);
    lines.push("");
    lines.push(`VERDICT   | ${verdict}`);

    return { lines, exclusions: reportExclusions, eligibleCount: candidates.length };
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    const opts = parseArgs(process.argv.slice(2));

    process.stderr.write(`[replay] loading artifacts from ${opts.artifactDir}...\n`);

    let loaded: ReturnType<typeof loadArtifactCandidates>;
    try {
        loaded = loadArtifactCandidates(opts.artifactDir, opts.executionModel, opts.direction);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[replay] FATAL: ${detail}`);
        process.exitCode = 1;
        return;
    }
    const { candidates, exclusions, totalTrades } = loaded;

    process.stderr.write(`[replay] extracted ${candidates.length} candidates from ${totalTrades} trades (${exclusions.mapping} mapping, ${exclusions.censored} censored, ${exclusions.direction} direction, ${exclusions.corrupt} corrupt)\n`);

    if (candidates.length === 0) {
        console.error("[replay] FATAL: No valid candidates extracted from artifacts.");
        process.exitCode = 1;
        return;
    }

    const result = runReplay(candidates, opts, exclusions, totalTrades);
    process.stdout.write(result.lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
