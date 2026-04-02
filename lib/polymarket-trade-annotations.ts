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
    BacktestPolymarketTradeSummary,
} from "./types/polymarket-outcomes";

function clampProbability(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) {
        return null;
    }
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function getYesPriceForOffset(outcome: PolymarketOutcomeRow, entryOffset: number): number | null {
    switch (entryOffset) {
        case 0:
            return outcome.yes_open_price;
        case 1:
            return outcome.yes_entry_minute_1_price;
        case 2:
            return outcome.yes_entry_minute_2_price;
        case 3:
            return outcome.yes_entry_minute_3_price;
        case 4:
            return outcome.yes_entry_minute_4_price;
        default:
            return null;
    }
}

export function getTradeMarketEntryPrice(
    outcome: PolymarketOutcomeRow,
    prediction: "yes" | "no",
    entryOffset = 0
): number | null {
    const yesPrice = clampProbability(getYesPriceForOffset(outcome, entryOffset));
    if (yesPrice === null) {
        return null;
    }
    return prediction === "yes"
        ? yesPrice
        : clampProbability(1 - yesPrice);
}

function getTradePayoutFromPrice(
    marketEntryPrice: number | null,
    isWin: boolean
): number | null {
    if (marketEntryPrice === null || !Number.isFinite(marketEntryPrice)) {
        return null;
    }
    return isWin ? (1 - marketEntryPrice) : -marketEntryPrice;
}

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

function buildPolymarketEvaluationIndexContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): Pick<PolymarketTradeEvaluationContext, "executionBarIndexByTs" | "evaluatedEvents" | "resolvedUpCount"> {
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
        executionBarIndexByTs,
        evaluatedEvents,
        resolvedUpCount,
    };
}

export function createPolymarketTradeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketTradeEvaluationContext {
    const shared = buildPolymarketEvaluationIndexContext(chartData, outcomes);
    return {
        outcomeByStartTs: new Map(outcomes.map((row) => [row.event_start_ts, row] as const)),
        ...shared,
    };
}

export function createPolymarketBridgeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketBridgeEvaluationContext {
    const shared = buildPolymarketEvaluationIndexContext(chartData, outcomes);
    return {
        outcomes,
        ...shared,
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
            marketEntryPrice: getTradeMarketEntryPrice(outcome, prediction),
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
            marketEntryPrice: getTradeMarketEntryPrice(outcome, prediction, entryOffset),
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
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;

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
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction);
        const payout = getTradePayoutFromPrice(marketEntryPrice, isWin);

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

        if (marketEntryPrice !== null && payout !== null) {
            pricedPredictions++;
            totalEntryPrice += marketEntryPrice;
            totalPayout += payout;
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
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;
    const expectancy = pricedPredictions > 0 ? totalPayout / pricedPredictions : 0;

    return {
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        pricedPredictions,
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
        avgEntryPrice,
        breakEvenWinRate,
        expectancy,
        edgeVsBreakEven: (scoredCount > 0 ? wins / scoredCount : 0) - breakEvenWinRate,
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
    context?: PolymarketBridgeEvaluationContext;
}): PolymarketEvalResult {
    const { chartData, trades, outcomes, strategyKey, selectedOffset, context } = args;
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
        context,
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
    context?: PolymarketBridgeEvaluationContext;
}): PolymarketEvalResult {
    const { chartData, mappedTrades, outcomes, strategyKey, selectedOffset } = args;
    const includeRows = args.includeRows !== false;
    const context = args.context ?? createPolymarketBridgeEvaluationContext(chartData, outcomes);

    const filteredForOffset = filterByEntryOffsetLegacy(mappedTrades, selectedOffset);
    const selected = deduplicateByEventLegacy(filteredForOffset);
    const executionBarIndexByTs = context.executionBarIndexByTs;
    const evaluatedEvents = context.evaluatedEvents;
    const resolvedUpCount = context.resolvedUpCount;

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
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;

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
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction, entryOffset);
        const payout = getTradePayoutFromPrice(marketEntryPrice, isWin);

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

        if (marketEntryPrice !== null && payout !== null) {
            pricedPredictions++;
            totalEntryPrice += marketEntryPrice;
            totalPayout += payout;
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
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;
    const expectancy = pricedPredictions > 0 ? totalPayout / pricedPredictions : 0;

    return {
        evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        pricedPredictions,
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
        avgEntryPrice,
        breakEvenWinRate,
        expectancy,
        edgeVsBreakEven: (scoredCount > 0 ? wins / scoredCount : 0) - breakEvenWinRate,
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
    const context = createPolymarketBridgeEvaluationContext(args.chartData, args.outcomes);

    for (let offset = 0; offset <= 4; offset++) {
        const evaluation = evaluatePolymarketBacktestTrades1mBridge({
            chartData: args.chartData,
            trades: args.trades,
            outcomes: args.outcomes,
            strategyKey: args.strategyKey,
            selectedOffset: offset,
            includeRows: false,
            context,
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

export function summarizePolymarketTradesForRun(args: {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    interval: string;
    selectedOffset?: number;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
}): Pick<
    BacktestPolymarketTradeSummary,
    "scoredTrades" | "missingOutcomeTrades" | "unscoredTrades" | "duplicateTradesIgnored" | "entryOffset" | "timingProfile"
> {
    const totalTrades = args.trades.length;

    if (args.interval === "1m") {
        const selectedOffset = args.selectedOffset ?? 0;
        const mappedTrades = mapTradesToEvents(args.trades, args.outcomes);
        const filteredForOffset = filterByEntryOffsetLegacy(mappedTrades, selectedOffset);
        const selectedTrades = deduplicateByEventLegacy(filteredForOffset);
        const scoredTrades = selectedTrades.length;
        const missingOutcomeTrades = Math.max(0, totalTrades - mappedTrades.length);
        const duplicateTradesIgnored = Math.max(0, filteredForOffset.length - selectedTrades.length);

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            entryOffset: selectedOffset,
            timingProfile: args.timingProfile,
        };
    }

    const outcomeByStartTs = new Map(args.outcomes.map((row) => [row.event_start_ts, row] as const));
    let scoredTrades = 0;
    let missingOutcomeTrades = 0;

    for (const trade of args.trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null || !outcomeByStartTs.has(entryTs)) {
            missingOutcomeTrades++;
            continue;
        }

        scoredTrades++;
    }

    return {
        scoredTrades,
        missingOutcomeTrades,
        unscoredTrades: missingOutcomeTrades,
        entryOffset: undefined,
        timingProfile: args.timingProfile,
    };
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
    const timingProfile = is1mRun
        ? buildPolymarketTimingProfileFor1mBridge({
            chartData: context.chartData,
            trades: result.trades,
            outcomes,
        })
        : undefined;
    const summary = summarizePolymarketTradesForRun({
        trades: result.trades,
        outcomes,
        interval: context.interval,
        selectedOffset,
        timingProfile,
    });

    return {
        ...result,
        trades,
        polymarketTradeSummary: {
            seriesId,
            outcomeRowsLoaded: outcomes.length,
            ...summary,
        },
    };
}
