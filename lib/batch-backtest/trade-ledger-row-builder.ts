/** Builds causal trade rows used by the Trade Gate. */
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
import {
    resolveAsIfOutcome,
    type AsIfPairModel,
} from "./trade-ledger-asif";
import type { NormalizedSettings } from "../types/backtest";
import type {
    OHLCVData,
    Signal,
    Trade,
    TradeDirection,
} from "../types/strategies";

import {
    TRADE_LEDGER_DEFAULT_HORIZONS,
    TRADE_LEDGER_VERSION,
    type TradeLedgerHorizonOutcome,
    type TradeLedgerNotExecutedReason,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
} from "./trade-ledger-schema";
export {
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

// ============================================================================
// Row builder â€” pure, read-only over the pair's row
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
    // Unlimited overlap resolves to Infinity in the engine â€” preserve it; a
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
    // (signalBarIndex, direction) identity â€” first wins, duplicates counted.
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
 * unblocked but no executed trade matched â€” a counted matching failure, never
 * a silent drop; `no_fill_bar` for entries beyond the data end; everything
 * else (sizing rejections, confirmation, â€¦) is `engine_skip`.
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


