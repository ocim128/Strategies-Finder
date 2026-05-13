import type { BacktestResult, Trade } from "../types/strategies";
import type {
    BacktestPolymarketTradeSummary,
    PolymarketEvalResult,
    PolymarketOutcomeRow,
    TradePolymarketOutcome,
} from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";
import {
    getEffectivePolymarketSeriesId,
    loadPolymarketOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
} from "../polymarket-btc5m";
import { buildPolymarketOutcomeBase } from "../polymarket-outcome-annotation";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { evaluateSecondMarketTrades, SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE } from "./backtest";
import { loadSecondMarketClobQuotes, normalizeSecondMarketChartSymbol } from "./api";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketBacktestSummary,
    SecondMarketSymbol,
    SecondMarketTradeResult,
} from "./types";

export type SecondMarketEvaluationContext = {
    symbol: SecondMarketSymbol;
    outcomeSymbol: SecondMarketSymbol;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    outcomes: PolymarketOutcomeRow[];
    quotes: PolymarketClob1sQuoteRow[];
};

export type SecondMarketEvaluationResult = {
    tradeResults: SecondMarketTradeResult[];
    summary: SecondMarketBacktestSummary;
    polymarketSummary: BacktestPolymarketTradeSummary;
    polymarketEval: PolymarketEvalResult;
    annotatedTrades: Trade[];
};

export function isSecondMarketPolymarketSupported(symbol: string, interval: string): boolean {
    return interval.trim().toLowerCase() === "1s" && normalizeSecondMarketChartSymbol(symbol) !== null;
}

export function isSecondMarketPolymarketScoringSupported(args: {
    symbol: string;
    interval: string;
    executionModel?: string;
}): boolean {
    return isSecondMarketPolymarketSupported(args.symbol, args.interval)
        && args.executionModel === "next_open";
}

function getTradeTimeRange(trades: readonly Trade[]): { startTs: number; endTs: number } | null {
    const times: number[] = [];
    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        const exitTs = parseTimeToUnixSeconds(trade.exitTime);
        if (entryTs !== null) times.push(entryTs);
        if (exitTs !== null) times.push(exitTs);
    }
    if (times.length === 0) return null;
    return {
        startTs: Math.min(...times),
        endTs: Math.max(...times),
    };
}

function predictionForTrade(trade: Pick<Trade, "type">): TradePolymarketOutcome["prediction"] {
    return trade.type === "long" ? "yes" : "no";
}

function isPredictionWin(prediction: TradePolymarketOutcome["prediction"], outcome: PolymarketOutcomeRow): boolean {
    return prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
}

function hasResolvedOutcome(outcome: PolymarketOutcomeRow): boolean {
    return outcome.resolution_source !== SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE;
}

function buildOutcomeRowsFromClobQuotes(quotes: readonly PolymarketClob1sQuoteRow[]): PolymarketOutcomeRow[] {
    const rows = new Map<string, PolymarketOutcomeRow>();
    for (const quote of quotes) {
        const key = `${quote.series_id}:${quote.event_start_ts}:${quote.yes_token_id}`;
        if (rows.has(key)) continue;
        rows.set(key, {
            series_id: quote.series_id,
            event_slug: quote.market_slug,
            market_slug: quote.market_slug,
            interval: quote.outcome_interval,
            event_start_ts: quote.event_start_ts,
            event_end_ts: quote.event_end_ts,
            yes_token_id: quote.yes_token_id,
            no_token_id: quote.no_token_id,
            yes_open_price: null,
            yes_entry_minute_1_price: null,
            yes_entry_minute_2_price: null,
            yes_entry_minute_3_price: null,
            yes_entry_minute_4_price: null,
            resolved_outcome_up: 0,
            resolution_source: SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE,
            updated_at: quote.updated_at,
        });
    }
    return [...rows.values()].sort((left, right) => left.event_start_ts - right.event_start_ts);
}

function mergeOutcomeRowsWithClobEvents(
    outcomes: readonly PolymarketOutcomeRow[],
    quotes: readonly PolymarketClob1sQuoteRow[]
): PolymarketOutcomeRow[] {
    const rows = new Map<string, PolymarketOutcomeRow>();
    for (const outcome of outcomes) {
        rows.set(`${outcome.series_id}:${outcome.event_start_ts}:${outcome.yes_token_id}`, outcome);
    }
    for (const outcome of buildOutcomeRowsFromClobQuotes(quotes)) {
        const key = `${outcome.series_id}:${outcome.event_start_ts}:${outcome.yes_token_id}`;
        if (!rows.has(key)) {
            rows.set(key, outcome);
        }
    }
    return [...rows.values()].sort((left, right) => left.event_start_ts - right.event_start_ts);
}

function buildNoEventAnnotation(trade: Trade, evaluationMode: PolymarketExitMode): TradePolymarketOutcome {
    return {
        eventStartTs: 0,
        eventEndTs: 0,
        eventSlug: "",
        marketSlug: "",
        prediction: predictionForTrade(trade),
        actualOutcomeUp: 0,
        isWin: null,
        evaluationMode,
        isProfitable: null,
        marketEntryPrice: null,
        marketExitPrice: null,
        marketExitTs: null,
        marketExitSource: "no_event",
        marketPnl: null,
    };
}

function buildTradeAnnotation(result: SecondMarketTradeResult, evaluationMode: PolymarketExitMode): TradePolymarketOutcome {
    if (!result.outcome) {
        return buildNoEventAnnotation(result.trade, evaluationMode);
    }

    const prediction = result.side ?? predictionForTrade(result.trade);
    const scored = result.pnl !== null;
    const isWin = scored && result.exitSource !== "signal" && hasResolvedOutcome(result.outcome)
        ? isPredictionWin(prediction, result.outcome)
        : null;
    return {
        ...buildPolymarketOutcomeBase({
            outcome: result.outcome,
            prediction,
            isWin,
        }),
        evaluationMode,
        isProfitable: result.isProfitable,
        marketEntrySource: "quote",
        marketEntryStatus: scored ? "filled" : result.exitSource === "duplicate" ? "duplicate" : undefined,
        marketEntryFillTs: result.entryQuoteTs,
        marketEntryPrice: result.entryPrice,
        marketExitPrice: result.exitPrice,
        marketExitTs: result.exitQuoteTs ?? (
            result.exitSource === "resolution" ? result.outcome.event_end_ts : null
        ),
        marketExitSource: result.exitSource,
        marketPnl: result.pnl,
    };
}

function summarizePolymarketResult(args: {
    context: SecondMarketEvaluationContext;
    summary: SecondMarketBacktestSummary;
    tradeResults: readonly SecondMarketTradeResult[];
    tradeCount: number;
    evaluationMode: PolymarketExitMode;
}): BacktestPolymarketTradeSummary {
    const { context, summary, tradeResults, tradeCount, evaluationMode } = args;
    const profitableTrades = tradeResults.filter((result) => result.isProfitable === true).length;
    const losingTrades = tradeResults.filter((result) => result.isProfitable === false).length;
    const neutralTrades = Math.max(0, summary.scoredTrades - profitableTrades - losingTrades);
    return {
        seriesId: context.seriesId,
        outcomeSymbol: context.outcomeSymbol,
        outcomeInterval: context.outcomeInterval,
        outcomeRowsLoaded: context.outcomes.length,
        scoredTrades: summary.scoredTrades,
        missingOutcomeTrades: summary.missingOutcomeTrades,
        unscoredTrades: Math.max(0, tradeCount - summary.scoredTrades),
        duplicateTradesIgnored: summary.duplicateTradesIgnored || undefined,
        evaluationMode,
        signalExitAllowMultipleTradesPerEvent: summary.allowMultipleTradesPerEvent,
        profitableTrades,
        losingTrades,
        neutralTrades,
        signalExitedTrades: summary.signalExitedTrades,
        resolvedTrades: summary.resolvedTrades,
        missingPriceTrades: summary.missingQuoteTrades || undefined,
        netPnl: summary.netPnl,
        grossProfit: summary.grossProfit,
        grossLoss: summary.grossLoss,
        profitFactor: summary.profitFactor,
        expectancy: summary.expectancy,
        avgEntryPrice: summary.avgEntryPrice ?? undefined,
        avgExitPrice: summary.avgExitPrice ?? undefined,
    };
}

function buildPolymarketEval(args: {
    outcomes: readonly PolymarketOutcomeRow[];
    tradeResults: readonly SecondMarketTradeResult[];
    summary: SecondMarketBacktestSummary;
    trades: readonly Trade[];
    evaluationMode: PolymarketExitMode;
}): PolymarketEvalResult {
    const { outcomes, tradeResults, summary, trades, evaluationMode } = args;
    const scored = tradeResults.filter((result) => result.pnl !== null);
    const wins = scored.filter((result) => result.isProfitable === true).length;
    const losses = scored.filter((result) => result.isProfitable === false).length;
    const scoredLong = scored.filter((result) => result.trade.type === "long");
    const scoredShort = scored.filter((result) => result.trade.type === "short");
    const longWins = scoredLong.filter((result) => result.isProfitable === true).length;
    const shortWins = scoredShort.filter((result) => result.isProfitable === true).length;
    const resolvedOutcomes = outcomes.filter(hasResolvedOutcome);
    const resolvedUpCount = resolvedOutcomes.filter((outcome) => outcome.resolved_outcome_up === 1).length;
    const predictionsTaken = trades.length;

    return {
        evaluatedEvents: outcomes.length,
        predictionsTaken,
        scoredPredictions: summary.scoredTrades,
        pricedPredictions: summary.scoredTrades,
        profitFactor: summary.profitFactor,
        grossProfit: summary.grossProfit,
        grossLoss: summary.grossLoss,
        wins,
        losses,
        skips: Math.max(0, predictionsTaken - summary.scoredTrades),
        winRate: summary.scoredTrades > 0 ? wins / summary.scoredTrades : 0,
        coverage: predictionsTaken > 0 ? summary.scoredTrades / predictionsTaken : 0,
        longPredictions: trades.filter((trade) => trade.type === "long").length,
        shortPredictions: trades.filter((trade) => trade.type === "short").length,
        longWins,
        shortWins,
        longWinRate: scoredLong.length > 0 ? longWins / scoredLong.length : 0,
        shortWinRate: scoredShort.length > 0 ? shortWins / scoredShort.length : 0,
        alwaysYesBaselineWinRate: resolvedOutcomes.length > 0 ? resolvedUpCount / resolvedOutcomes.length : 0,
        alwaysNoBaselineWinRate: resolvedOutcomes.length > 0 ? (resolvedOutcomes.length - resolvedUpCount) / resolvedOutcomes.length : 0,
        avgEntryPrice: summary.avgEntryPrice ?? 0,
        breakEvenWinRate: evaluationMode === "resolve_hold" ? (summary.avgEntryPrice ?? 0) : 0,
        expectancy: summary.expectancy,
        edgeVsBreakEven: evaluationMode === "resolve_hold"
            ? (summary.scoredTrades > 0 ? wins / summary.scoredTrades : 0) - (summary.avgEntryPrice ?? 0)
            : 0,
        missingOutcomeRows: summary.missingOutcomeTrades,
        ignoredSignals: summary.duplicateTradesIgnored,
        duplicateTradesIgnored: summary.duplicateTradesIgnored,
        evaluationMode,
        signalExitAllowMultipleTradesPerEvent: summary.allowMultipleTradesPerEvent,
        signalExitedTrades: summary.signalExitedTrades,
        resolvedTrades: summary.resolvedTrades,
        missingPriceTrades: summary.missingQuoteTrades,
        netPnl: summary.netPnl,
        avgExitPrice: summary.avgExitPrice ?? undefined,
        rows: [],
    };
}

export async function loadSecondMarketEvaluationContext(args: {
    symbol: string;
    outcomeSymbol?: string;
    outcomeInterval?: PolymarketOutcomeInterval;
    startTs: number;
    endTs: number;
}): Promise<SecondMarketEvaluationContext | null> {
    const symbol = normalizeSecondMarketChartSymbol(args.symbol);
    const outcomeInterval = resolvePolymarketOutcomeInterval(args.outcomeInterval);
    const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(args.symbol, args.outcomeSymbol);
    const outcomeSymbol = resolvedOutcomeSymbol
        ? normalizeSecondMarketChartSymbol(resolvedOutcomeSymbol)
        : null;
    if (!symbol || !outcomeSymbol) return null;

    const seriesId = getEffectivePolymarketSeriesId(args.symbol, outcomeInterval, outcomeSymbol);
    if (!seriesId) return null;

    const startTs = Math.floor(args.startTs);
    const endTs = Math.floor(args.endTs);
    const [outcomes, quotes] = await Promise.all([
        loadPolymarketOutcomesForTimeRange(args.symbol, startTs, endTs, outcomeSymbol, outcomeInterval),
        loadSecondMarketClobQuotes({
            symbol: outcomeSymbol,
            seriesId,
            startTs,
            endTs,
        }),
    ]);

    return {
        symbol,
        outcomeSymbol,
        seriesId,
        outcomeInterval,
        outcomes: mergeOutcomeRowsWithClobEvents(outcomes, quotes),
        quotes,
    };
}

export function evaluateSecondMarketBacktest(args: {
    result: Pick<BacktestResult, "trades">;
    context: SecondMarketEvaluationContext;
    trades?: readonly Trade[];
    polymarketExitMode?: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
}): SecondMarketEvaluationResult {
    const trades = [...(args.trades ?? args.result.trades)];
    const evaluationMode = "signal_exit_same_event";
    const evaluated = evaluateSecondMarketTrades({
        trades,
        outcomes: args.context.outcomes,
        quotes: args.context.quotes,
        evaluationMode,
        allowMultipleTradesPerEvent: args.polymarketSignalExitAllowMultipleTradesPerEvent,
        mode: "strict",
        fillSource: "bid_ask",
    });
    const annotatedByTrade = new Map<Trade, TradePolymarketOutcome>(
        evaluated.results.map((result) => [result.trade, buildTradeAnnotation(result, evaluationMode)] as const)
    );
    const annotatedTrades = args.result.trades.map((trade) => ({
        ...trade,
        polymarketOutcome: annotatedByTrade.get(trade) ?? null,
    }));
    const polymarketSummary = summarizePolymarketResult({
        context: args.context,
        summary: evaluated.summary,
        tradeResults: evaluated.results,
        tradeCount: trades.length,
        evaluationMode,
    });
    return {
        tradeResults: evaluated.results,
        summary: evaluated.summary,
        polymarketSummary,
        polymarketEval: buildPolymarketEval({
            outcomes: args.context.outcomes,
            tradeResults: evaluated.results,
            summary: evaluated.summary,
            trades,
            evaluationMode,
        }),
        annotatedTrades,
    };
}

export async function annotateBacktestResultWithSecondMarketClob(args: {
    result: BacktestResult;
    symbol: string;
    interval: string;
    outcomeSymbol?: string;
    outcomeInterval?: PolymarketOutcomeInterval;
    executionModel?: string;
    polymarketExitMode?: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
}): Promise<BacktestResult> {
    if (
        !isSecondMarketPolymarketScoringSupported({
            symbol: args.symbol,
            interval: args.interval,
            executionModel: args.executionModel,
        })
        || args.result.trades.length === 0
    ) {
        return args.result;
    }

    const range = getTradeTimeRange(args.result.trades);
    if (!range) return args.result;

    const context = await loadSecondMarketEvaluationContext({
        symbol: args.symbol,
        outcomeSymbol: args.outcomeSymbol,
        outcomeInterval: args.outcomeInterval,
        startTs: range.startTs - 300,
        endTs: range.endTs + 300,
    });
    if (!context) return args.result;

    const evaluated = evaluateSecondMarketBacktest({
        result: args.result,
        context,
        polymarketExitMode: args.polymarketExitMode,
        polymarketSignalExitAllowMultipleTradesPerEvent: args.polymarketSignalExitAllowMultipleTradesPerEvent,
    });

    return {
        ...args.result,
        trades: evaluated.annotatedTrades,
        polymarketTradeSummary: evaluated.polymarketSummary,
    };
}
