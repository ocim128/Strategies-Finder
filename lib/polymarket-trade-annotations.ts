import {
    getPolymarket5mSeriesIdForSymbol,
    loadPolymarket5mOutcomesForTimeRange,
    supportsPolymarketOutcomeBridgeRun,
    isSupportedPolymarketMultiIntervalRun,
} from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import {
    type MappedPolymarketTrade as LegacyMappedPolymarketTrade,
    findContainingEvent,
    calculateEntryOffset as calculateMinuteEntryOffset,
    deduplicateByEvent as deduplicateByEventLegacy,
    filterByEntryOffset as filterByEntryOffsetLegacy,
    mapTradesToEvents,
    selectTradesForScoring as selectTradesForScoringLegacy,
} from "./polymarket-1m-5m-bridge";
import type { BacktestResult, OHLCVData, Trade } from "./types/strategies";
import type {
    BacktestPolymarketTimingProfileEntry,
    PolymarketEvalResult,
    PolymarketEvalRow,
    PolymarketOutcomeRow,
} from "./types/polymarket-outcomes";

type AnnotationContext = {
    symbol: string;
    interval: string;
    executionModel?: string;
    chartData: OHLCVData[];
};

export type PolymarketTradeEvaluationContext = {
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>;
    executionBarIndexByTs: Map<number, number>;
    evaluatedEvents: number;
    resolvedUpCount: number;
};

/**
 * Extended context for 1m -> 5m bridge evaluation.
 */
export type PolymarketBridgeEvaluationContext = {
    /** All outcome rows for containment lookup */
    outcomes: readonly PolymarketOutcomeRow[];
    /** Execution bar index by timestamp */
    executionBarIndexByTs: Map<number, number>;
    /** Evaluated events count from outcomes */
    evaluatedEvents: number;
    /** Resolved UP count from outcomes */
    resolvedUpCount: number;
};

export function createPolymarketTradeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketTradeEvaluationContext {
    const executionBarIndexByTs = new Map<number, number>();
    const validTargetTs = new Set<number>();

    for (let i = 0; i < chartData.length; i++) {
        const ts = parseTimeToUnixSeconds(chartData[i]?.time);
        if (ts === null) continue;
        if (!executionBarIndexByTs.has(ts)) {
            executionBarIndexByTs.set(ts, i);
        }
        if (i > 0) {
            validTargetTs.add(ts);
        }
    }

    let evaluatedEvents = 0;
    let resolvedUpCount = 0;
    for (const row of outcomes) {
        if (!validTargetTs.has(row.event_start_ts)) continue;
        evaluatedEvents++;
        resolvedUpCount += row.resolved_outcome_up;
    }

    return {
        outcomeByStartTs: new Map(outcomes.map((row) => [row.event_start_ts, row] as const)),
        executionBarIndexByTs,
        evaluatedEvents,
        resolvedUpCount,
    };
}

function buildAnnotatedTrade(
    trade: Trade,
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = outcomeByStartTs.get(entryTs);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
        },
    };
}

/**
 * Build an annotated trade for 1m -> 5m bridge evaluation.
 * Uses containment-based event lookup instead of exact timestamp match.
 */
function buildAnnotatedTradeForBridge(
    trade: Trade,
    outcomes: readonly PolymarketOutcomeRow[],
    selectedOffset?: number
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = findContainingEvent(entryTs, outcomes);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const entryOffset = calculateMinuteEntryOffset(entryTs, outcome.event_start_ts);
    if (entryOffset < 0 || entryOffset > 4) {
        return { ...trade, polymarketOutcome: null };
    }

    // Filter by selected offset if specified
    if (selectedOffset !== undefined && entryOffset !== selectedOffset) {
        return { ...trade, polymarketOutcome: null };
    }

    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
            entryOffset,
        },
    };
}

export function annotateTradesWithPolymarketOutcomes(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): Trade[] {
    const outcomeByStartTs = new Map(outcomes.map((row) => [row.event_start_ts, row] as const));
    return trades.map((trade) => buildAnnotatedTrade(trade, outcomeByStartTs));
}

export function annotateTradesWithPolymarketOutcomesForRun(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: string,
    selectedOffset?: number
): Trade[] {
    if (interval !== "1m") {
        return annotateTradesWithPolymarketOutcomes(trades, outcomes);
    }

    const selectedTrades = selectTradesForScoringLegacy(trades, outcomes, "1m", selectedOffset);
    const selectedTradeSet = new Set(selectedTrades.map((mapped: LegacyMappedPolymarketTrade) => mapped.trade));

    return trades.map((trade) => (
        selectedTradeSet.has(trade)
            ? buildAnnotatedTradeForBridge(trade, outcomes, selectedOffset)
            : { ...trade, polymarketOutcome: null }
    ));
}

export function evaluatePolymarketBacktestTrades(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    context?: PolymarketTradeEvaluationContext;
    includeRows?: boolean;
}): PolymarketEvalResult {
    const { trades, strategyKey } = args;
    const context = args.context ?? createPolymarketTradeEvaluationContext(args.chartData, args.outcomes);
    const includeRows = args.includeRows !== false;
    const rows: PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let scoredLongPredictions = 0;
    let scoredShortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;
    let missingOutcomeRows = 0;

    for (const trade of trades) {
        if (trade.type === "long") {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            missingOutcomeRows++;
            continue;
        }

        const outcome = context.outcomeByStartTs.get(entryTs);
        if (!outcome) {
            missingOutcomeRows++;
            continue;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const isWin = prediction === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        if (trade.type === "long") {
            scoredLongPredictions++;
        } else {
            scoredShortPredictions++;
        }

        if (isWin) {
            wins++;
            if (trade.type === "long") longWins++;
            else shortWins++;
        } else {
            losses++;
        }

        if (includeRows) {
            const executionBarIndex = context.executionBarIndexByTs.get(entryTs);
            const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
            const signalTime = signalBarIndex >= 0
                ? (parseTimeToUnixSeconds(args.chartData[signalBarIndex]?.time) ?? entryTs)
                : entryTs;
            rows.push({
                eventStartTs: outcome.event_start_ts,
                eventEndTs: outcome.event_end_ts,
                eventSlug: outcome.event_slug,
                signalBarIndex,
                signalTime,
                prediction,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin,
                signalReason: undefined,
                strategyKey,
            });
        }
    }

    const predictionsTaken = trades.length;
    const scoredCount = includeRows ? rows.length : wins + losses;

    return {
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        wins,
        losses,
        skips: Math.max(0, context.evaluatedEvents - scoredCount),
        winRate: scoredCount > 0 ? wins / scoredCount : 0,
        coverage: context.evaluatedEvents > 0 ? scoredCount / context.evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: scoredLongPredictions > 0 ? longWins / scoredLongPredictions : 0,
        shortWinRate: scoredShortPredictions > 0 ? shortWins / scoredShortPredictions : 0,
        alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
        alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
        missingOutcomeRows,
        ignoredSignals: 0,
        rows,
    };
}

/**
 * Evaluate Polymarket backtest trades for 1m -> 5m bridge runs.
 *
 * This function:
 * - Maps 1m trade entry times into containing 5m Polymarket events
 * - Filters trades by selected entry offset (0..4)
 * - Deduplicates multiple trades in the same event+offset bucket
 * - Scores only the first trade per event
 *
 * @param args - Evaluation arguments
 * @returns Polymarket evaluation result with offset-aware metrics
 */
export function evaluatePolymarketBacktestTrades1mBridge(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    selectedOffset: number;
    includeRows?: boolean;
}): PolymarketEvalResult {
    const { chartData, trades, outcomes, strategyKey, selectedOffset } = args;
    const includeRows = args.includeRows !== false;

    const mappedTrades = mapTradesToEvents(trades, outcomes);
    return evaluateMappedPolymarketBacktestTrades1mBridge({
        chartData,
        mappedTrades,
        outcomes,
        strategyKey,
        selectedOffset,
        includeRows,
        predictionsTaken: trades.length,
    });
}

export function evaluateMappedPolymarketBacktestTrades1mBridge(args: {
    chartData: OHLCVData[];
    mappedTrades: readonly LegacyMappedPolymarketTrade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    selectedOffset: number;
    includeRows?: boolean;
    predictionsTaken?: number;
}): PolymarketEvalResult {
    const { chartData, mappedTrades, outcomes, strategyKey, selectedOffset } = args;
    const includeRows = args.includeRows !== false;

    const filteredForOffset = filterByEntryOffsetLegacy(mappedTrades, selectedOffset);
    const selected = deduplicateByEventLegacy(filteredForOffset);

    // Build context for metrics
    const executionBarIndexByTs = new Map<number, number>();
    const validTargetTs = new Set<number>();
    for (let i = 0; i < chartData.length; i++) {
        const ts = parseTimeToUnixSeconds(chartData[i]?.time);
        if (ts === null) continue;
        if (!executionBarIndexByTs.has(ts)) {
            executionBarIndexByTs.set(ts, i);
        }
        if (i > 0) {
            validTargetTs.add(ts);
        }
    }

    let evaluatedEvents = 0;
    let resolvedUpCount = 0;
    for (const row of outcomes) {
        if (!validTargetTs.has(row.event_start_ts)) continue;
        evaluatedEvents++;
        resolvedUpCount += row.resolved_outcome_up;
    }

    // Evaluate selected trades
    const rows: PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let scoredLongPredictions = 0;
    let scoredShortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;
    let missingOutcomeRows = 0;

    for (const mapped of selected) {
        const { trade, outcome, entryOffset, entryTs } = mapped;

        if (trade.type === "long") {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const isWin = prediction === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        if (trade.type === "long") {
            scoredLongPredictions++;
        } else {
            scoredShortPredictions++;
        }

        if (isWin) {
            wins++;
            if (trade.type === "long") longWins++;
            else shortWins++;
        } else {
            losses++;
        }

        if (includeRows) {
            const executionBarIndex = executionBarIndexByTs.get(entryTs);
            const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
            const signalTime = signalBarIndex >= 0
                ? (parseTimeToUnixSeconds(chartData[signalBarIndex]?.time) ?? entryTs)
                : entryTs;
            rows.push({
                eventStartTs: outcome.event_start_ts,
                eventEndTs: outcome.event_end_ts,
                eventSlug: outcome.event_slug,
                signalBarIndex,
                signalTime,
                prediction,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin,
                signalReason: undefined,
                strategyKey,
                entryOffset,
            });
        }
    }

    const predictionsTaken = Math.max(
        0,
        Number.isFinite(args.predictionsTaken) ? Number(args.predictionsTaken) : mappedTrades.length
    );
    const scoredCount = includeRows ? rows.length : wins + losses;
    const duplicateTradesIgnored = Math.max(0, filteredForOffset.length - selected.length);

    return {
        evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        wins,
        losses,
        skips: Math.max(0, evaluatedEvents - scoredCount),
        winRate: scoredCount > 0 ? wins / scoredCount : 0,
        coverage: evaluatedEvents > 0 ? scoredCount / evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: scoredLongPredictions > 0 ? longWins / scoredLongPredictions : 0,
        shortWinRate: scoredShortPredictions > 0 ? shortWins / scoredShortPredictions : 0,
        alwaysYesBaselineWinRate: evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0,
        alwaysNoBaselineWinRate: evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0,
        missingOutcomeRows,
        ignoredSignals: 0,
        entryOffset: selectedOffset,
        duplicateTradesIgnored,
        rows,
    };
}

export function buildPolymarketTimingProfileFor1mBridge(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
}): BacktestPolymarketTimingProfileEntry[] {
    const profile: BacktestPolymarketTimingProfileEntry[] = [];

    for (let offset = 0; offset <= 4; offset++) {
        const evaluation = evaluatePolymarketBacktestTrades1mBridge({
            chartData: args.chartData,
            trades: args.trades,
            outcomes: args.outcomes,
            strategyKey: args.strategyKey,
            selectedOffset: offset,
            includeRows: false,
        });

        profile.push({
            entryOffset: offset,
            scoredTrades: evaluation.scoredPredictions,
            wins: evaluation.wins,
            losses: evaluation.losses,
            winRate: evaluation.winRate,
            coverage: evaluation.coverage,
            missingOutcomeRows: evaluation.missingOutcomeRows,
            duplicateTradesIgnored: evaluation.duplicateTradesIgnored ?? 0,
        });
    }

    return profile;
}

export async function annotateBacktestResultWithPolymarketOutcomes(
    result: BacktestResult,
    context: AnnotationContext,
    selectedOffset?: number
): Promise<BacktestResult> {
    const is1mRun = context.interval === "1m";
    const is5mRun = context.interval === "5m";
    const isMultiIntervalRun = ["15m", "1h", "4h"].includes(context.interval);

    // Support 5m (legacy), 1m (bridge), and multi-interval runs (15m, 1h, 4h)
    if (
        result.trades.length === 0 ||
        context.executionModel !== "next_open" ||
        context.chartData.length < 2 ||
        (!is5mRun && !is1mRun && !isMultiIntervalRun)
    ) {
        return result;
    }

    // Check symbol support - use multi-interval check for 15m/1h/4h, legacy check for 1m/5m
    const isValidInterval = isMultiIntervalRun
        ? isSupportedPolymarketMultiIntervalRun(context.symbol, context.interval)
        : supportsPolymarketOutcomeBridgeRun(context.symbol, context.interval);
    
    if (!isValidInterval) {
        return result;
    }

    const seriesId = getPolymarket5mSeriesIdForSymbol(context.symbol);
    if (!seriesId) {
        return result;
    }

    const targetTimes = result.trades
        .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
        .filter((value): value is number => value !== null);
    if (targetTimes.length === 0) {
        return result;
    }

    const startTs = Math.min(...targetTimes);
    const endTs = Math.max(...targetTimes);
    const outcomes = await loadPolymarket5mOutcomesForTimeRange(context.symbol, startTs, endTs);

    const trades = annotateTradesWithPolymarketOutcomesForRun(
        result.trades,
        outcomes,
        context.interval,
        selectedOffset
    );
    const scoredTrades = trades.filter((trade) => Boolean(trade.polymarketOutcome)).length;
    const duplicateTradesIgnored = is1mRun
        ? Math.max(0, filterByEntryOffsetLegacy(mapTradesToEvents(result.trades, outcomes), selectedOffset ?? 0).length - scoredTrades)
        : 0;
    const timingProfile = is1mRun
        ? buildPolymarketTimingProfileFor1mBridge({
            chartData: context.chartData,
            trades: result.trades,
            outcomes,
        })
        : undefined;

    return {
        ...result,
        trades,
        polymarketTradeSummary: {
            seriesId,
            outcomeRowsLoaded: outcomes.length,
            scoredTrades,
            missingOutcomeTrades: trades.length - scoredTrades,
            entryOffset: is1mRun ? (selectedOffset ?? 0) : undefined,
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            timingProfile,
        },
    };
}
