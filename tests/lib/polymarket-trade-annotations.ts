import { loadBtc5mPolymarketOutcomesForTimeRange, BTC_5M_POLYMARKET_SERIES_ID, isSupportedPolymarketBtc5mRun } from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { BacktestResult, OHLCVData, Trade } from "./types/strategies";
import type { PolymarketEvalResult, PolymarketEvalRow, PolymarketOutcomeRow } from "./types/polymarket-outcomes";

type AnnotationContext = {
    symbol: string;
    interval: string;
    executionModel?: string;
    chartData: OHLCVData[];
};

export type PolymarketTradeEvaluationContext = {
    executionTargetBySignalTs: Map<number, number>;
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>;
    signalBarIndexByTs: Map<number, number>;
    evaluatedEvents: number;
    resolvedUpCount: number;
};

function buildExecutionTargetTimeMap(chartData: OHLCVData[]): Map<number, number> {
    const map = new Map<number, number>();
    for (let i = 0; i < chartData.length - 1; i++) {
        const signalTs = parseTimeToUnixSeconds(chartData[i]?.time);
        const nextTs = parseTimeToUnixSeconds(chartData[i + 1]?.time);
        if (signalTs === null || nextTs === null) continue;
        if (!map.has(signalTs)) {
            map.set(signalTs, nextTs);
        }
    }
    return map;
}

export function createPolymarketTradeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketTradeEvaluationContext {
    const signalBarIndexByTs = new Map<number, number>();
    const validTargetTs = new Set<number>();

    for (let i = 0; i < chartData.length; i++) {
        const ts = parseTimeToUnixSeconds(chartData[i]?.time);
        if (ts === null) continue;
        if (!signalBarIndexByTs.has(ts)) {
            signalBarIndexByTs.set(ts, i);
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
        executionTargetBySignalTs: buildExecutionTargetTimeMap(chartData),
        outcomeByStartTs: new Map(outcomes.map((row) => [row.event_start_ts, row] as const)),
        signalBarIndexByTs,
        evaluatedEvents,
        resolvedUpCount,
    };
}

function buildAnnotatedTrade(
    trade: Trade,
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>,
    executionTargetBySignalTs: Map<number, number>
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const targetTs = executionTargetBySignalTs.get(entryTs);
    if (targetTs === undefined) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = outcomeByStartTs.get(targetTs);
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
        const targetTs = entryTs === null ? undefined : context.executionTargetBySignalTs.get(entryTs);
        if (targetTs === undefined) {
            missingOutcomeRows++;
            continue;
        }

        const outcome = context.outcomeByStartTs.get(targetTs);
        if (!outcome) {
            missingOutcomeRows++;
            continue;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const isWin = prediction === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        if (isWin) {
            wins++;
            if (trade.type === "long") longWins++;
            else shortWins++;
        } else {
            losses++;
        }

        if (includeRows) {
            rows.push({
                eventStartTs: outcome.event_start_ts,
                eventEndTs: outcome.event_end_ts,
                eventSlug: outcome.event_slug,
                signalBarIndex: entryTs === null ? -1 : (context.signalBarIndexByTs.get(entryTs) ?? -1),
                signalTime: entryTs ?? 0,
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
        longWinRate: longPredictions > 0 ? longWins / longPredictions : 0,
        shortWinRate: shortPredictions > 0 ? shortWins / shortPredictions : 0,
        alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
        alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
        missingOutcomeRows,
        ignoredSignals: 0,
        rows,
    };
}

export async function annotateBacktestResultWithPolymarketOutcomes(
    result: BacktestResult,
    context: AnnotationContext
): Promise<BacktestResult> {
    if (
        result.trades.length === 0 ||
        context.executionModel !== "next_open" ||
        context.chartData.length < 2 ||
        !isSupportedPolymarketBtc5mRun(context.symbol, context.interval)
    ) {
        return result;
    }

    const executionTargetBySignalTs = buildExecutionTargetTimeMap(context.chartData);
    const targetTimes = result.trades
        .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
        .filter((value): value is number => value !== null)
        .map((entryTs) => executionTargetBySignalTs.get(entryTs))
        .filter((value): value is number => value !== undefined);
    if (targetTimes.length === 0) {
        return result;
    }

    const startTs = Math.min(...targetTimes);
    const endTs = Math.max(...targetTimes);
    const outcomes = await loadBtc5mPolymarketOutcomesForTimeRange(startTs, endTs);
    const evaluationContext = createPolymarketTradeEvaluationContext(context.chartData, outcomes);

    const trades = result.trades.map((trade) => buildAnnotatedTrade(
        trade,
        evaluationContext.outcomeByStartTs,
        executionTargetBySignalTs
    ));
    const scoredTrades = trades.filter((trade) => Boolean(trade.polymarketOutcome)).length;

    return {
        ...result,
        trades,
        polymarketTradeSummary: {
            seriesId: BTC_5M_POLYMARKET_SERIES_ID,
            outcomeRowsLoaded: outcomes.length,
            scoredTrades,
            missingOutcomeTrades: trades.length - scoredTrades,
        },
    };
}
