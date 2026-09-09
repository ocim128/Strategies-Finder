/**
 * Trade Ledger exporter for server-side Batch runs (v3 features).
 *
 * While a Batch run executes with the ledger toggle ON, the vite plugin
 * (`batch-backtest-vite-plugin.ts`) writes one run folder containing:
 *   - `provenance.json`   — run config snapshot + replay eligibility (start)
 *   - `ledger.jsonl`      — one line per ENTRY SIGNAL, appended per pair inside
 *                           the awaited `onSymbolComplete` path (audit F2 shape)
 *   - `signal-ranks.jsonl`— cross-sectional rank of each signal among the
 *                           signals fired at the same timestamp (run end)
 *   - `summary.json`      — totals, per-pair suppression rates, completeness
 *
 * v2 adds the AS-IF outcome per entry signal (`asIf`), computed with the
 * engine's own math by `trade-ledger-asif.ts`, so the offline checker can
 * REPLAY admission rules over all candidates instead of scoring only the
 * original run's executed survivors. `asIf` is null only for right-censored
 * signals (no fill bar near data end) — or when the run config is not
 * replay-eligible (`asIfReason: "replay_ineligible"`; the checker refuses
 * those folders anyway).
 *
 * v3 adds fixed-horizon outcomes (`horizons`) for pair-selection judging. The
 * ledger is a pure side artifact: every function here only READS the
 * runner's rows, and any write failure is recorded (`ledgerComplete: false`)
 * instead of failing the batch run.
 *
 * Import hygiene: this module is bundled into the vite.config.ts esbuild bundle
 * (via the plugin). It may import only node builtins and pure lib leaf modules
 * — nothing that reaches `lightweight-charts` / `constants.ts` /
 * `chart-manager.ts`.
 */

import { appendFile, mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    buildTradeLedgerFeatureSeries,
    buildTradeLedgerFeatureValues,
    type TradeLedgerFeatureSeries,
} from "./trade-ledger-features";
import {
    allowsSignalAsEntry,
    getExecutionShift,
    resolveExecutionPrice,
    signalToPositionDirection,
} from "../strategies/backtest/backtest-utils";
import { debugLogger } from "../debug-logger";
import {
    resolveAsIfOutcome,
    type AsIfPairModel,
} from "./trade-ledger-asif";
import { TradeLedgerSnapshotWriter } from "./trade-ledger-snapshot-writer";
import type { NormalizedSettings } from "../types/backtest";
import type {
    OHLCVData,
    Signal,
    Trade,
    TradeDirection,
} from "../types/strategies";
import type { PairFeatureSnapshotSource } from "../pair-features/types";

import {
    TRADE_LEDGER_DEFAULT_HORIZONS,
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_VERSION,
    type TradeLedgerFinalizeResult,
    type TradeLedgerHorizonOutcome,
    type TradeLedgerNotExecutedReason,
    type TradeLedgerPairSuppression,
    type TradeLedgerProvenance,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
    type TradeLedgerSummary,
    type TradeLedgerWindow,
} from "./trade-ledger-schema";
export {
    TRADE_LEDGER_DEFAULT_FOLDER,
    TRADE_LEDGER_DEFAULT_HORIZONS,
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_SUPPORTED_VERSIONS,
    TRADE_LEDGER_SUPPORTED_FEATURE_VERSIONS,
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_FEATURE_RETURN_BARS,
    TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR,
    TRADE_LEDGER_RULE_ALLOWED_FIELDS,
    TRADE_LEDGER_RULE_FORBIDDEN_FIELDS,
    TRADE_LEDGER_VERSION,
    type TradeLedgerAsIfOutcome,
    type TradeLedgerDirection,
    type TradeLedgerFinalizeResult,
    type TradeLedgerHorizonOutcome,
    type TradeLedgerNotExecutedReason,
    type TradeLedgerPairSuppression,
    type TradeLedgerProvenance,
    type TradeLedgerReplayProvenance,
    type TradeLedgerRankRow,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
    type TradeLedgerSummary,
    type TradeLedgerWindow,
} from "./trade-ledger-schema";

export {
    buildBatchRunLedgerBodyField,
    parseTradeLedgerHorizons,
    type TradeLedgerRunOptions,
} from "./trade-ledger-wire";

// ============================================================================
// Folder helpers
// ============================================================================

/**
 * Validate a user-supplied ledger folder. Returns a normalized relative path
 * (`/`-separated, no drive letters, no absolute root, no `.`/`..` segments),
 * or null when the input is not a safe relative folder.
 */
export function sanitizeTradeLedgerFolder(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().replace(/\\/g, "/");
    if (!trimmed || trimmed.length > 200) return null;
    if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/")) return null;
    const parts = trimmed.split("/");
    for (const part of parts) {
        if (!part || part === "." || part === "..") return null;
    }
    return parts.join("/");
}

/** `yyyy-MM-dd_HHmm` local-time stamp for the run folder name. */
export function formatLedgerRunStamp(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ============================================================================
// Row builder — pure, read-only over the pair's row
// ============================================================================

export interface BuildTradeLedgerRowsArgs {
    pair: string;
    data: OHLCVData[];
    signals: readonly Signal[] | undefined;
    trades: readonly Trade[] | undefined;
    context: TradeLedgerRowContext;
    /** Canonical leg identity supplied by the run/loader; never inferred here. */
    baseSymbol?: string | null;
    quoteSymbol?: string | null;
    /** Leg closes aligned to `data`'s pair-bar timestamps. */
    baseCloses?: readonly (number | null)[];
    quoteCloses?: readonly (number | null)[];
    /** Per-pair as-if model; null/undefined when the run is replay-ineligible. */
    asIfModel?: AsIfPairModel | null;
    /** Optional prepared features shared with the as-if model for this pair. */
    featureSeries?: TradeLedgerFeatureSeries;
}

export interface TradeLedgerPairRows {
    rows: TradeLedgerRow[];
    /** Same-direction signals collapsed onto an already-seen decision bar. */
    duplicatesCollapsed: number;
    rightCensored: number;
    /** Signal times for duplicate candidates, used to window suppression totals. */
    duplicateSignalTimes?: number[];
    /** Signal times for right-censored rows, used to window suppression totals. */
    rightCensoredSignalTimes?: number[];
}

export interface TradeLedgerPairSnapshotInput {
    pair: string;
    data: readonly OHLCVData[];
    trades: readonly Trade[];
    /** Canonical leg identity supplied by the loader/run context. */
    baseSymbol?: string | null;
    quoteSymbol?: string | null;
}

export interface TradeLedgerAppendOptions {
    /**
     * Wait for the source snapshot's four files before returning. The batch
     * server disables this per-pair wait; finalize still drains all captures
     * before publishing the completed snapshot manifest.
     */
    awaitSnapshotCapture?: boolean;
}

/**
 * Build one ledger row per ENTRY SIGNAL for a single pair.
 *
 * Entry candidates mirror the engine's own gate: `allowsSignalAsEntry` under
 * the run's resolved tradeDirection (exit-only signals from the Exit Strategy
 * Override are never entries). Signals are sorted by DECISION time (stable)
 * before trailing per-pair statistics are computed, and duplicate
 * same-direction signals on one decision bar collapse deterministically
 * (first wins, counted). Fill time/price mirror `prepareSignals`' execution
 * shift. Signals are matched to executed trades by (direction, fillTime,
 * entryPrice within slippage tolerance). All features read bars at or before
 * the signal bar. Every row carries an as-if outcome (engine math) unless
 * right-censored or the run is replay-ineligible.
 */
export function buildTradeLedgerRowsForPair(args: BuildTradeLedgerRowsArgs): TradeLedgerPairRows {
    const {
        pair,
        data,
        signals,
        trades,
        context,
        baseSymbol,
        quoteSymbol,
        baseCloses,
        quoteCloses,
        asIfModel,
        featureSeries: preparedFeatureSeries,
    } = args;
    if (!signals || signals.length === 0 || !data || data.length === 0) {
        return { rows: [], duplicatesCollapsed: 0, rightCensored: 0 };
    }

    const featureSeries = preparedFeatureSeries
        ?? buildTradeLedgerFeatureSeries(data, baseCloses, quoteCloses);
    const { barSecs } = featureSeries;

    // Trade lookup: (direction | fill time) bucket, matched by entry price
    // within the run's slippage tolerance (the engine applies slippage to the
    // fill price; commission does not alter entryPrice).
    const tradeBuckets = new Map<string, Trade[]>();
    const tradeSecs = new Map<Trade, { entry: number | null; exit: number | null }>();
    for (const trade of trades ?? []) {
        const entrySec = parseTimeToUnixSeconds(trade.entryTime);
        const exitSec = parseTimeToUnixSeconds(trade.exitTime);
        tradeSecs.set(trade, { entry: entrySec, exit: exitSec });
        if (entrySec === null) continue;
        const key = `${trade.type}|${entrySec}`;
        const bucket = tradeBuckets.get(key);
        if (bucket) bucket.push(trade);
        else tradeBuckets.set(key, [trade]);
    }
    const claimed = new Set<Trade>();
    let executedTradeCount = 0;
    let executedTradeWins = 0;
    // Unlimited overlap resolves to Infinity in the engine — preserve it; a
    // non-finite or non-positive cap means unlimited, never 1.
    const maxOpenTrades = Number.isFinite(context.maxOpenTrades) && context.maxOpenTrades > 0
        ? context.maxOpenTrades
        : Number.POSITIVE_INFINITY;
    const priorTradeClassifier: PriorTradeClassifierState = {
        pendingEntries: [],
        activeExits: [],
        maxExitBar: -1,
    };
    const cooldownBars = Math.max(0, context.cooldownBars);
    const rows: TradeLedgerRow[] = [];
    let duplicatesCollapsed = 0;
    let rightCensored = 0;
    const duplicateSignalTimes: number[] = [];
    const rightCensoredSignalTimes: number[] = [];
    let previousSignalBarIndex: number | null = null;

    // W4: decision-time order (stable) before trailing statistics; W5:
    // (signalBarIndex, direction) identity — first wins, duplicates counted.
    const ordered = signals
        .map((signal, index) => ({ signal, index }))
        .filter(({ signal }) => isEntrySignal(signal, context.tradeDirection))
        .sort((a, b) => {
            const aSec = parseTimeToUnixSeconds(a.signal.time);
            const bSec = parseTimeToUnixSeconds(b.signal.time);
            const aTime = aSec ?? Number.MAX_SAFE_INTEGER;
            const bTime = bSec ?? Number.MAX_SAFE_INTEGER;
            if (aTime !== bTime) return aTime - bTime;
            return a.index - b.index;
        });
    const seenIdentity = new Set<string>();

    for (const { signal } of ordered) {
        const signalBarIndex = resolveSignalBarIndex(signal, barSecs);
        const signalSec = signalBarIndex === -1 ? parseTimeToUnixSeconds(signal.time) : barSecs[signalBarIndex];
        if (signalSec === null) continue;
        const direction = signalToPositionDirection(signal.type);
        const identity = `${signalBarIndex}|${direction}`;
        if (signalBarIndex !== -1) {
            if (seenIdentity.has(identity)) {
                duplicatesCollapsed += 1;
                duplicateSignalTimes.push(signalSec);
                continue;
            }
            seenIdentity.add(identity);
        }
        advancePriorTradeClassifier(priorTradeClassifier, signalSec, maxOpenTrades);

        const fillBarIndex = signalBarIndex === -1
            ? -1
            : signalBarIndex + getExecutionShift(context as unknown as NormalizedSettings);
        const hasFillBar = fillBarIndex >= 0 && fillBarIndex < data.length;
        const rawFillPrice = hasFillBar
            ? resolveExecutionPrice(data, signal, signalBarIndex, fillBarIndex, context as unknown as NormalizedSettings)
            : null;
        const fillSec = hasFillBar ? barSecs[fillBarIndex] : null;
        const fillPrice =
            rawFillPrice !== null && Number.isFinite(rawFillPrice) && rawFillPrice > 0 ? rawFillPrice : null;

        const matched = matchTrade(
            tradeBuckets.get(`${direction}|${fillSec}`),
            claimed,
            fillPrice,
            context.slippageRate,
        );

        const prior = { trades: executedTradeCount, wins: executedTradeWins };
        const row: TradeLedgerRow = {
            ledgerVersion: TRADE_LEDGER_VERSION,
            pair,
            baseSymbol: baseSymbol ?? "",
            quoteSymbol: quoteSymbol ?? "",
            direction,
            signalTime: signalSec,
            signalBarIndex: signalBarIndex === -1 ? -1 : signalBarIndex,
            fillTime: fillSec,
            fillPrice,
            executed: matched !== null,
            notExecutedReason: matched !== null
                ? null
                : classifyNotExecuted(
                    priorTradeClassifier,
                    fillBarIndex,
                    hasFillBar,
                    maxOpenTrades,
                    cooldownBars,
                ),
            ...buildTradeLedgerFeatureValues({
                data,
                series: featureSeries,
                signalBarIndex,
                signalSec,
                prior,
                baseCloses,
                quoteCloses,
            }),
            feat_barsSincePairLastFire:
                signalBarIndex >= 0 && previousSignalBarIndex !== null && previousSignalBarIndex >= 0
                    ? signalBarIndex - previousSignalBarIndex
                    : null,
            feat_rank: null,
            feat_candidatesAtTime: null,
            asIf: null,
            asIfReason: null,
            horizons: buildTradeLedgerHorizonOutcomes(
                data,
                barSecs,
                fillBarIndex,
                direction,
                context.ledgerHorizons ?? [...TRADE_LEDGER_DEFAULT_HORIZONS],
            ),
        };
        if (matched) {
            executedTradeCount += 1;
            if (matched.pnlPercent > 0) executedTradeWins += 1;
            const matchedSecs = tradeSecs.get(matched);
            // The cooldown/overlap reconstruction tracks the TRADE's exit bar,
            // not the signal's fill bar.
            const exitBar = resolveExitBarIndex(barSecs, matchedSecs?.exit ?? null);
            if (matchedSecs?.entry !== null && matchedSecs?.entry !== undefined && matchedSecs.exit !== null && matchedSecs.exit !== undefined) {
                if (Number.isFinite(maxOpenTrades)) {
                    pushPendingEntry(priorTradeClassifier.pendingEntries, { entry: matchedSecs.entry, exit: matchedSecs.exit });
                }
                priorTradeClassifier.maxExitBar = Math.max(priorTradeClassifier.maxExitBar, exitBar);
            }
            // Executed rows carry the trade's ACTUAL fill (post-slippage).
            row.fillPrice = matched.entryPrice;
            row.exitTime = matchedSecs?.exit ?? undefined;
            row.exitPrice = matched.exitPrice;
            row.pnlPercent = matched.pnlPercent;
            row.fees = matched.fees ?? 0;
            row.exitReason = matched.exitReason;
        }
        if (signalBarIndex >= 0) previousSignalBarIndex = signalBarIndex;
        // As-if outcome for EVERY entry signal (v2 replay contract).
        if (asIfModel) {
            if (signalBarIndex === -1) {
                row.asIf = null;
                row.asIfReason = "right_censored";
                rightCensored += 1;
                rightCensoredSignalTimes.push(signalSec);
            } else {
                const asIf = resolveAsIfOutcome(asIfModel, data, signalBarIndex, signal);
                if (asIf.outcome) {
                    row.asIf = asIf.outcome;
                } else if (asIf.rightCensored) {
                    row.asIf = null;
                    row.asIfReason = "right_censored";
                    rightCensored += 1;
                    rightCensoredSignalTimes.push(signalSec);
                } else {
                    // Unreachable today; never zero-fill.
                    row.asIf = null;
                    row.asIfReason = "right_censored";
                    rightCensored += 1;
                    rightCensoredSignalTimes.push(signalSec);
                }
            }
        } else {
            row.asIf = null;
            row.asIfReason = "replay_ineligible";
        }
        rows.push(row);
    }
    return { rows, duplicatesCollapsed, rightCensored, duplicateSignalTimes, rightCensoredSignalTimes };
}

function buildTradeLedgerHorizonOutcomes(
    data: readonly OHLCVData[],
    barSecs: readonly (number | null)[],
    fillBarIndex: number,
    direction: TradeLedgerRow["direction"],
    horizons: readonly number[],
): Partial<Record<string, TradeLedgerHorizonOutcome>> {
    const outcomes: Partial<Record<string, TradeLedgerHorizonOutcome>> = {};
    const fillBar = data[fillBarIndex];
    const entryTimeSec = fillBarIndex >= 0 && fillBarIndex < data.length ? barSecs[fillBarIndex] ?? null : null;
    const entryPrice = fillBarIndex >= 0 && fillBarIndex < data.length ? fillBar?.open ?? null : null;
    if (entryPrice !== null && (!Number.isFinite(entryPrice) || entryPrice <= 0)) {
        throw new Error(`Trade-ledger horizon entry price is invalid at fill bar ${fillBarIndex}.`);
    }
    for (const horizon of horizons) {
        const key = String(horizon);
        const exitBarIndex = fillBarIndex + horizon;
        const exitBar = exitBarIndex >= 0 && exitBarIndex < data.length ? data[exitBarIndex] : undefined;
        const exitTimeSec = exitBarIndex >= 0 && exitBarIndex < data.length ? barSecs[exitBarIndex] ?? null : null;
        const exitPrice = exitBar?.close ?? null;
        if (
            entryTimeSec === null
            || entryPrice === null
            || exitBar === undefined
            || exitTimeSec === null
            || exitPrice === null
        ) {
            outcomes[key] = {
                entryTimeSec,
                entryPrice,
                exitTimeSec: null,
                exitPrice: null,
                pnlPercent: null,
                status: "right_censored",
            };
            continue;
        }
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
            throw new Error(`Trade-ledger horizon exit price is invalid at bar ${exitBarIndex}.`);
        }
        outcomes[key] = {
            entryTimeSec,
            entryPrice,
            exitTimeSec,
            exitPrice,
            pnlPercent: direction === "long"
                ? exitPrice / entryPrice - 1
                : 1 - exitPrice / entryPrice,
            status: "ok",
        };
    }
    return outcomes;
}

function isEntrySignal(signal: Signal, tradeDirection: TradeDirection): boolean {
    return signal.exitOnly !== true && allowsSignalAsEntry(signal.type, tradeDirection);
}

/**
 * Resolve the decision bar index for a signal. Prefers the signal's own
 * barIndex when it points at a bar carrying the signal's time; falls back to a
 * binary search over the (time-ordered) dataset.
 */
function resolveSignalBarIndex(signal: Signal, barSecs: (number | null)[]): number {
    const signalSec = parseTimeToUnixSeconds(signal.time);
    if (signalSec === null) return -1;
    const declared = Number.isFinite(signal.barIndex) ? Math.trunc(signal.barIndex as number) : -1;
    if (declared >= 0 && declared < barSecs.length && barSecs[declared] === signalSec) {
        return declared;
    }
    let lo = 0;
    let hi = barSecs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = barSecs[mid];
        if (t === null) return -1;
        if (t === signalSec) return mid;
        if (t < signalSec) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

function resolveExitBarIndex(barSecs: (number | null)[], exitSec: number | null): number {
    if (exitSec === null) return barSecs.length - 1;
    // Last bar whose time <= exit time (time-ordered data).
    let lo = 0;
    let hi = barSecs.length - 1;
    let found = barSecs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = barSecs[mid];
        if (t === null) break;
        if (t <= exitSec) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function matchTrade(
    bucket: Trade[] | undefined,
    claimed: Set<Trade>,
    fillPrice: number | null,
    slippageRate: number,
): Trade | null {
    if (!bucket || fillPrice === null) return null;
    const tolerance = fillPrice * slippageRate + 1e-9;
    for (const trade of bucket) {
        if (claimed.has(trade)) continue;
        if (Math.abs(trade.entryPrice - fillPrice) <= tolerance) {
            claimed.add(trade);
            return trade;
        }
    }
    return null;
}

/**
 * Approximate the engine's suppression cause for a not-executed candidate.
 * `position_open` when the executed trades of this pair already occupy every
 * open slot at the decision moment; `cooldown` when the run's post-exit entry
 * cooldown blocks the fill bar; `match_missing` when the pair looked FLAT and
 * unblocked but no executed trade matched — a counted matching failure, never
 * a silent drop; `no_fill_bar` for entries beyond the data end; everything
 * else (sizing rejections, confirmation, …) is `engine_skip`.
 */
interface PriorTradeInterval {
    entry: number;
    exit: number;
}

interface PriorTradeClassifierState {
    /** Min-heap ordered by entry time for matched trades not yet time-visible. */
    pendingEntries: PriorTradeInterval[];
    /** Min-heap of exit times for intervals currently open at the signal time. */
    activeExits: number[];
    maxExitBar: number;
}

function advancePriorTradeClassifier(
    state: PriorTradeClassifierState,
    signalSec: number,
    maxOpenTrades: number,
): void {
    if (Number.isFinite(maxOpenTrades)) {
        while (state.pendingEntries.length > 0 && state.pendingEntries[0]!.entry <= signalSec) {
            const interval = popPendingEntry(state.pendingEntries)!;
            if (interval.exit > signalSec) pushMinHeap(state.activeExits, interval.exit);
        }
        while (state.activeExits.length > 0 && state.activeExits[0]! <= signalSec) {
            popMinHeap(state.activeExits);
        }
    }
}

function classifyNotExecuted(
    state: PriorTradeClassifierState,
    fillBarIndex: number,
    hasFillBar: boolean,
    maxOpenTrades: number,
    cooldownBars: number,
): TradeLedgerNotExecutedReason {
    if (!hasFillBar) return "no_fill_bar";
    if (state.activeExits.length >= maxOpenTrades) return "position_open";
    if (cooldownBars > 0 && state.maxExitBar >= 0 && state.maxExitBar + cooldownBars - 1 >= fillBarIndex) {
        return "cooldown";
    }
    return "match_missing";
}

function pushPendingEntry(heap: PriorTradeInterval[], value: PriorTradeInterval): void {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent]!.entry <= heap[index]!.entry) break;
        [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
        index = parent;
    }
}

function popPendingEntry(heap: PriorTradeInterval[]): PriorTradeInterval | undefined {
    if (heap.length === 0) return undefined;
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
        heap[0] = last;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (left < heap.length && heap[left]!.entry < heap[smallest]!.entry) smallest = left;
            if (right < heap.length && heap[right]!.entry < heap[smallest]!.entry) smallest = right;
            if (smallest === index) break;
            [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
            index = smallest;
        }
    }
    return first;
}

function pushMinHeap(heap: number[], value: number): void {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent]! <= heap[index]!) break;
        [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
        index = parent;
    }
}

function popMinHeap(heap: number[]): number | undefined {
    if (heap.length === 0) return undefined;
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
        heap[0] = last;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (left < heap.length && heap[left]! < heap[smallest]!) smallest = left;
            if (right < heap.length && heap[right]! < heap[smallest]!) smallest = right;
            if (smallest === index) break;
            [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
            index = smallest;
        }
    }
    return first;
}

// ============================================================================
// Writer — per-run folder with incremental ledger appends
// ============================================================================

export interface TradeLedgerWriterDeps {
    mkdir: typeof mkdir;
    appendFile: typeof appendFile;
    writeFile: typeof writeFile;
    /** Backoff between append retries. Injectable so tests run instantly. */
    delay: (ms: number) => Promise<void>;
}

export interface TradeLedgerAppendTimings {
    ledgerRowEncodeMs: number;
    ledgerFileWriteMs: number;
    ledgerBookkeepingMs: number;
    ledgerSnapshotEnqueueMs: number;
}

/** Transient FS errors worth retrying; anything else fails on first attempt. */
const RETRYABLE_LEDGER_ERROR_CODES = new Set(["EBUSY", "EPERM", "ESTALE"]);
const LEDGER_APPEND_MAX_ATTEMPTS = 3;
const LEDGER_APPEND_BACKOFF_MS = [50, 200];

/**
 * Bounded retry for ledger appends (audit W3): on EBUSY/EPERM/ESTALE only,
 * retry up to 3 total attempts with a 50ms/200ms backoff. Any other error, or
 * a final failure, propagates to the caller's loud-but-non-fatal recording.
 */
async function appendWithRetry(deps: TradeLedgerWriterDeps, path: string, data: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LEDGER_APPEND_MAX_ATTEMPTS; attempt += 1) {
        try {
            await deps.appendFile(path, data, "utf8");
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (!code || !RETRYABLE_LEDGER_ERROR_CODES.has(code) || attempt === LEDGER_APPEND_MAX_ATTEMPTS) {
                throw error;
            }
            await deps.delay(LEDGER_APPEND_BACKOFF_MS[attempt - 1] ?? 200);
        }
    }
    throw lastError;
}

export interface TradeLedgerWriterCreateOptions {
    rootDir: string;
    folder: string;
    runId: string;
    startedAtMs: number;
    provenance: TradeLedgerProvenance;
    ledgerWindow?: TradeLedgerWindow;
    deps?: Partial<TradeLedgerWriterDeps>;
}

/** Pair accounting for summary.json (audit W4). */
export interface TradeLedgerPairAccounting {
    /** Pairs submitted in the request (provenance.pairCount). */
    submittedPairs: number;
    /** Pairs whose dataset loaded and ran (output.loadedSymbols). */
    loadedPairs: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PROVENANCE_FILE = "provenance.json";
const LEDGER_FILE = "ledger.jsonl";
const RANKS_FILE = "signal-ranks.jsonl";
const SUMMARY_FILE = "summary.json";
const RANK_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Per-run ledger writer. `create` never throws — a setup failure returns null
 * and logs, so a ledger problem can never fail the batch run (the run's final
 * status surfaces the incompleteness instead). Appends and finalize record
 * failures on the writer and resolve normally.
 */
export class TradeLedgerWriter {
    readonly runDir: string;
    private readonly runId: string;
    private readonly startedAtMs: number;
    private ledgerComplete = true;
    private failedWrites = 0;
    private lastError: string | null = null;
    private finalized = false;
    private rightCensored = 0;
    private duplicateSignalsCollapsed = 0;
    private readonly totals = { signals: 0, executed: 0, notExecuted: 0 };
    private readonly perPair = new Map<string, { signals: number; executed: number }>();
    /** Pairs whose rows were DROPPED by a failed append (audit W2) — not a count only. */
    private readonly failedPairs = new Set<string>();
    /** Bounded (signalTime → distinct pairs) tuples — interned pair strings, no candle data. */
    private readonly rankPairsByTime = new Map<number, Set<string>>();
    private readonly deps: TradeLedgerWriterDeps;
    private readonly snapshotWriter: TradeLedgerSnapshotWriter;
    private readonly ledgerWindow: TradeLedgerWindow;
    private readonly useLedgerFileHandle: boolean;
    private ledgerFileHandle: FileHandle | null = null;
    private finalizeResult: TradeLedgerFinalizeResult | null = null;
    private readonly appendTimings: TradeLedgerAppendTimings = {
        ledgerRowEncodeMs: 0,
        ledgerFileWriteMs: 0,
        ledgerBookkeepingMs: 0,
        ledgerSnapshotEnqueueMs: 0,
    };

    private constructor(
        runDir: string,
        runId: string,
        startedAtMs: number,
        deps: TradeLedgerWriterDeps,
        ledgerWindow: TradeLedgerWindow,
        useLedgerFileHandle: boolean,
    ) {
        this.runDir = runDir;
        this.runId = runId;
        this.startedAtMs = startedAtMs;
        this.deps = deps;
        this.ledgerWindow = ledgerWindow;
        this.useLedgerFileHandle = useLedgerFileHandle;
        this.snapshotWriter = new TradeLedgerSnapshotWriter({ runDir });
    }

    static async create(options: TradeLedgerWriterCreateOptions): Promise<TradeLedgerWriter | null> {
        const deps: TradeLedgerWriterDeps = {
            mkdir: options.deps?.mkdir ?? mkdir,
            appendFile: options.deps?.appendFile ?? appendFile,
            writeFile: options.deps?.writeFile ?? writeFile,
            delay: options.deps?.delay ?? wait,
        };
        const folder = sanitizeTradeLedgerFolder(options.folder);
        if (!folder) {
            debugLogger.warn("batch.server.ledger_invalid_folder", { folder: options.folder });
            return null;
        }
        const dirName = options.runId
            ? `${formatLedgerRunStamp(options.startedAtMs)}_${options.runId}`
            : formatLedgerRunStamp(options.startedAtMs);
        const runDir = join(options.rootDir, folder, dirName);
        const ledgerWindow: TradeLedgerWindow = {
            fromSec: options.ledgerWindow?.fromSec ?? null,
            toSec: options.ledgerWindow?.toSec ?? null,
        };
        const writer = new TradeLedgerWriter(
            runDir,
            options.runId,
            options.startedAtMs,
            deps,
            ledgerWindow,
            options.deps?.appendFile === undefined,
        );
        try {
            // The parent may be created recursively; the per-run directory is
            // deliberately exclusive so a timestamp/run-id collision cannot
            // overwrite a prior experiment's provenance or ledger.
            await deps.mkdir(join(options.rootDir, folder), { recursive: true });
            await deps.mkdir(runDir);
            await deps.writeFile(
                join(runDir, PROVENANCE_FILE),
                JSON.stringify({ ...options.provenance, runId: options.runId, ledgerWindow }, null, 2),
                "utf8",
            );
            // Create the ledger eagerly so a successfully loaded pair with no
            // accepted entries still has a hashable, valid empty ledger.
            await deps.writeFile(join(runDir, LEDGER_FILE), "", "utf8");
        } catch (error) {
            debugLogger.warn("batch.server.ledger_create_failed", {
                runDir,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
        return writer;
    }

    getAppendTimings(): TradeLedgerAppendTimings {
        return { ...this.appendTimings };
    }

    private async appendLedger(data: string): Promise<void> {
        if (!this.useLedgerFileHandle) {
            await appendWithRetry(this.deps, join(this.runDir, LEDGER_FILE), data);
            return;
        }
        let lastError: unknown;
        for (let attempt = 1; attempt <= LEDGER_APPEND_MAX_ATTEMPTS; attempt += 1) {
            try {
                this.ledgerFileHandle ??= await open(join(this.runDir, LEDGER_FILE), "a");
                await this.ledgerFileHandle.write(data, null, "utf8");
                return;
            } catch (error) {
                lastError = error;
                const handle = this.ledgerFileHandle;
                this.ledgerFileHandle = null;
                await handle?.close().catch(() => undefined);
                const code = (error as NodeJS.ErrnoException | null)?.code;
                if (!code || !RETRYABLE_LEDGER_ERROR_CODES.has(code) || attempt === LEDGER_APPEND_MAX_ATTEMPTS) {
                    throw error;
                }
                await this.deps.delay(LEDGER_APPEND_BACKOFF_MS[attempt - 1] ?? 200);
            }
        }
        throw lastError;
    }

    private async closeLedgerFileHandle(): Promise<void> {
        const handle = this.ledgerFileHandle;
        this.ledgerFileHandle = null;
        await handle?.close().catch(() => undefined);
    }

    /**
     * Append one pair's rows as a single incremental write. When the source
     * payload is supplied (the normal server path), capture it only after the
     * ledger append succeeds. Never throws.
     */
    async appendPairRows(
        pairRows: TradeLedgerPairRows,
        source?: TradeLedgerPairSnapshotInput,
        options: TradeLedgerAppendOptions = {},
    ): Promise<void> {
        const isWindowed = this.ledgerWindow.fromSec !== null || this.ledgerWindow.toSec !== null;
        const rows = isWindowed
            ? pairRows.rows.filter((row) =>
                (this.ledgerWindow.fromSec === null || row.signalTime >= this.ledgerWindow.fromSec)
                && (this.ledgerWindow.toSec === null || row.signalTime <= this.ledgerWindow.toSec))
            : pairRows.rows;
        const rowStart = this.totals.signals;
        const countInWindow = (times: readonly number[] | undefined, fallback: number): number => {
            if (!isWindowed) return fallback;
            if (!times) return 0;
            return times.filter((time) =>
                (this.ledgerWindow.fromSec === null || time >= this.ledgerWindow.fromSec)
                && (this.ledgerWindow.toSec === null || time <= this.ledgerWindow.toSec),
            ).length;
        };
        try {
            if (rows.length > 0) {
                const encodeStartedAt = performance.now();
                const lines = rows.map((row) => JSON.stringify(row));
                lines.push("");
                this.appendTimings.ledgerRowEncodeMs += performance.now() - encodeStartedAt;
                const writeStartedAt = performance.now();
                await this.appendLedger(lines.join("\n"));
                this.appendTimings.ledgerFileWriteMs += performance.now() - writeStartedAt;
            }
            this.duplicateSignalsCollapsed += countInWindow(pairRows.duplicateSignalTimes, pairRows.duplicatesCollapsed);
            this.rightCensored += countInWindow(pairRows.rightCensoredSignalTimes, pairRows.rightCensored);
            const bookkeepingStartedAt = performance.now();
            let executedForPair = 0;
            for (const row of rows) {
                this.totals.signals += 1;
                if (row.executed) {
                    this.totals.executed += 1;
                    executedForPair += 1;
                } else this.totals.notExecuted += 1;
                // Per-time Set of distinct pairs — no repeated `includes` scan
                // inside large same-timestamp buckets.
                let pairs = this.rankPairsByTime.get(row.signalTime);
                if (!pairs) {
                    pairs = new Set<string>();
                    this.rankPairsByTime.set(row.signalTime, pairs);
                }
                pairs.add(row.pair);
            }
            if (rows.length > 0) {
                // buildTradeLedgerRowsForPair produces one pair per append;
                // update its summary once instead of doing a class-map lookup
                // and write for every row.
                const pair = rows[0]!.pair;
                const totals = this.perPair.get(pair) ?? { signals: 0, executed: 0 };
                totals.signals += rows.length;
                totals.executed += executedForPair;
                this.perPair.set(pair, totals);
            }
            this.appendTimings.ledgerBookkeepingMs += performance.now() - bookkeepingStartedAt;
            if (source) {
                const snapshotStartedAt = performance.now();
                const snapshotSource: PairFeatureSnapshotSource = {
                    identity: {
                        pair: source.pair,
                        baseSymbol: source.baseSymbol ?? rows[0]?.baseSymbol ?? "",
                        quoteSymbol: source.quoteSymbol ?? rows[0]?.quoteSymbol ?? "",
                    },
                    bars: source.data,
                    trades: source.trades,
                    entries: rows.map((row, index) => [rowStart + index, row.signalBarIndex, row.direction, row.signalTime]),
                    warmupEntries: this.ledgerWindow.fromSec === null
                        ? []
                        : pairRows.rows
                            .filter((row) => row.signalTime < this.ledgerWindow.fromSec!)
                            .map((row) => [row.signalBarIndex, row.direction, row.signalTime]),
                    rowStart,
                };
                if (options.awaitSnapshotCapture === false) {
                    await this.snapshotWriter.enqueuePair(snapshotSource);
                } else {
                    await this.snapshotWriter.capturePair(snapshotSource);
                }
                this.appendTimings.ledgerSnapshotEnqueueMs += performance.now() - snapshotStartedAt;
            }
        } catch (error) {
            // W2: record WHICH pairs lost rows, not just a count.
            for (const row of rows) this.failedPairs.add(row.pair);
            this.recordFailure(error);
        }
    }

    /**
     * Write `signal-ranks.jsonl` + `summary.json` at run end. Idempotent;
     * never throws. Ranks are 1-based positions of the DISTINCT pairs signaling
     * at each timestamp, ordered ascending by pair symbol.
     */
    async finalize(input: { cancelled: boolean; finishedAtMs: number; accounting?: TradeLedgerPairAccounting }): Promise<TradeLedgerFinalizeResult> {
        if (this.finalized) {
            return this.finalizeResult!;
        }
        this.finalized = true;
        await this.closeLedgerFileHandle();

        let summary: TradeLedgerSummary | null = null;
        try {
            const rankPath = join(this.runDir, RANKS_FILE);
            const rankLines: string[] = [];
            let rankChunkBytes = 0;
            let wroteRankLine = false;
            const flushRankChunk = async (): Promise<void> => {
                if (rankLines.length === 0) return;
                await appendWithRetry(this.deps, rankPath, rankLines.join(""));
                rankLines.length = 0;
                rankChunkBytes = 0;
            };
            const times = [...this.rankPairsByTime.keys()].sort((a, b) => a - b);
            for (const time of times) {
                const pairs = [...this.rankPairsByTime.get(time)!].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                for (const [index, pair] of pairs.entries()) {
                    const line = `${JSON.stringify({
                        signalTime: time,
                        pair,
                        rank: index + 1,
                        candidatesAtTime: pairs.length,
                    })}\n`;
                    rankLines.push(line);
                    wroteRankLine = true;
                    rankChunkBytes += Buffer.byteLength(line, "utf8");
                    if (rankChunkBytes >= RANK_APPEND_CHUNK_BYTES) await flushRankChunk();
                }
            }
            // Each emitted line already carries the historical trailing
            // newline. Keep the empty-rank append so the file is created just
            // as it was by the former single-write implementation.
            if (wroteRankLine) await flushRankChunk();
            else await appendWithRetry(this.deps, rankPath, "");
        } catch (error) {
            this.recordFailure(error);
        }

        try {
            const perPair: TradeLedgerPairSuppression[] = [];
            for (const [pair, totals] of this.perPair) {
                const notExecuted = totals.signals - totals.executed;
                perPair.push({
                    pair,
                    signals: totals.signals,
                    executed: totals.executed,
                    notExecuted,
                    suppressionRate: totals.signals > 0 ? notExecuted / totals.signals : 0,
                });
            }
            perPair.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
            const topSuppressedPairs = [...perPair]
                .sort((a, b) =>
                    b.suppressionRate - a.suppressionRate
                    || b.notExecuted - a.notExecuted
                    || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0))
                .slice(0, 20);
            const rowBearingPairs = this.perPair.size;
            const submittedPairs = Math.max(input.accounting?.submittedPairs ?? rowBearingPairs, rowBearingPairs);
            const loadedPairs = Math.min(
                Math.max(input.accounting?.loadedPairs ?? rowBearingPairs, rowBearingPairs),
                submittedPairs,
            );
            summary = {
                ledgerVersion: TRADE_LEDGER_VERSION,
                featureVersion: TRADE_LEDGER_FEATURE_VERSION,
                runId: this.runId,
                startedAt: new Date(this.startedAtMs).toISOString(),
                finishedAt: new Date(input.finishedAtMs).toISOString(),
                cancelled: input.cancelled,
                ledgerComplete: this.ledgerComplete,
                failedWrites: this.failedWrites,
                lastError: this.combinedLastError(),
                totals: { pairs: rowBearingPairs, ...this.totals },
                suppressionRate: this.totals.signals > 0 ? this.totals.notExecuted / this.totals.signals : 0,
                ledgerWindow: this.ledgerWindow,
                // W4 pair accounting: submittedPairs − loadedPairs = pairs that
                // failed to load/run (names ride the run's done event + logs);
                // loadedPairs − rowBearingPairs = loaded pairs with zero entry
                // signals; failedPairs = pairs whose rows were DROPPED by a
                // failed append.
                submittedPairs,
                loadedPairs,
                rowBearingPairs,
                emptyPairs: Math.max(0, loadedPairs - rowBearingPairs),
                failedPairs: [...this.failedPairs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
                rightCensored: this.rightCensored,
                duplicateSignalsCollapsed: this.duplicateSignalsCollapsed,
                perPairSuppression: perPair,
                topSuppressedPairs,
            };
            await this.deps.writeFile(join(this.runDir, SUMMARY_FILE), JSON.stringify(summary, null, 2), "utf8");
        } catch (error) {
            this.recordFailure(error);
        }

        let snapshotComplete = false;
        let sourceSnapshotSha256: string | null = null;
        if (this.snapshotWriter.isActive && !input.cancelled && this.ledgerComplete) {
            const snapshotResult = await this.snapshotWriter.finalize({
                ledgerComplete: this.ledgerComplete,
                ledgerRowCount: this.totals.signals,
                ledgerPath: join(this.runDir, LEDGER_FILE),
                provenancePath: join(this.runDir, PROVENANCE_FILE),
                summaryPath: join(this.runDir, SUMMARY_FILE),
                ranksPath: join(this.runDir, RANKS_FILE),
                // The exporter builds entries from the same `rows` passed to
                // appendLedger and only starts the snapshot after that append
                // succeeds. Avoid rereading/parsing the complete ledger at
                // finalize; standalone snapshot writers retain read-back
                // verification by default.
                ledgerCoverageAlreadyVerified: true,
            });
            snapshotComplete = snapshotResult.complete;
            sourceSnapshotSha256 = snapshotResult.manifestSha256;
            if (snapshotResult.error) {
                // Snapshot failure is optional-artifact failure: preserve a
                // checkable, complete legacy ledger and only amend its
                // terminal diagnostic text.
                this.lastError = this.combinedLastError(snapshotResult.error);
                if (summary) {
                    summary.lastError = this.lastError;
                    try {
                        await this.deps.writeFile(join(this.runDir, SUMMARY_FILE), JSON.stringify(summary, null, 2), "utf8");
                    } catch (error) {
                        debugLogger.warn("batch.server.ledger_snapshot_summary_update_failed", {
                            runDir: this.runDir,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }

        this.finalizeResult = {
            ledgerComplete: this.ledgerComplete,
            failedWrites: this.failedWrites,
            lastError: this.combinedLastError(),
            totals: { ...this.totals, pairs: this.perPair.size },
            snapshotComplete,
            snapshotError: this.snapshotWriter.error,
            sourceSnapshotSha256,
        };
        return this.finalizeResult;
    }

    private combinedLastError(snapshotError = this.snapshotWriter.error): string | null {
        if (!this.lastError) return snapshotError ? `source snapshot failed: ${snapshotError}` : null;
        if (!snapshotError || this.lastError.includes(snapshotError)) return this.lastError;
        return `${this.lastError}; source snapshot failed: ${snapshotError}`;
    }

    private recordFailure(error: unknown): void {
        this.ledgerComplete = false;
        this.failedWrites += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.ledger_write_failed", {
            runDir: this.runDir,
            error: this.lastError,
        });
    }
}
