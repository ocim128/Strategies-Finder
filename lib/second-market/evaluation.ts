import type { BacktestResult, Trade } from "../types/strategies";
import type {
    BacktestPolymarketTradeSummary,
    PolymarketEvalResult,
    PolymarketOutcomeRow,
    TradePolymarketOutcome,
} from "../types/polymarket-outcomes";
import {
    isPolymarketOneSecondSignalExitExecutionModel,
    isSameEventPolymarketExitMode,
    type PolymarketExitMode,
} from "../polymarket-exit-mode";
import {
    getEffectivePolymarketSeriesId,
    loadPolymarketOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
} from "../polymarket-btc5m";
import { buildPolymarketOutcomeBase } from "../polymarket-outcome-annotation";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { evaluateSecondMarketTrades, SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE } from "./backtest";
import { getClobQuoteTimeSec } from "./alignment";
import {
    loadSecondMarketClobQuotesWithStats,
    loadSecondMarketGammaSnapshots,
    normalizeSecondMarketChartSymbol,
    type SecondMarketClobQuoteStats,
} from "./api";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { Polymarket1sGammaContextRow } from "../types/strategies";
import type { PolymarketPostSignalLimitEntrySettings } from "../polymarket-post-signal-limit-entry";
import type { PolymarketProtectionSettingFields } from "../polymarket-protection-settings";
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
    quoteStats?: SecondMarketClobQuoteStats;
    gammaSnapshots: Polymarket1sGammaContextRow[];
};

export type SecondMarketEvaluationResult = {
    tradeResults: SecondMarketTradeResult[];
    summary: SecondMarketBacktestSummary;
    polymarketSummary: BacktestPolymarketTradeSummary;
    polymarketEval: PolymarketEvalResult;
    annotatedTrades: Trade[];
};

function resolveCloseExecutionTimestampShiftSec(executionModel?: string): number {
    return executionModel === "signal_close" || executionModel === "next_close" ? 1 : 0;
}

function shiftTradeTimeSeconds(time: Trade["entryTime"], shiftSec: number): Trade["entryTime"] {
    if (shiftSec <= 0) return time;
    const seconds = parseTimeToUnixSeconds(time);
    return seconds === null ? time : (seconds + shiftSec) as Trade["entryTime"];
}

function buildScoredTradePairs(
    trades: readonly Trade[],
    executionModel?: string
): Array<{ original: Trade; scored: Trade }> {
    const shiftSec = resolveCloseExecutionTimestampShiftSec(executionModel);
    if (shiftSec <= 0) {
        return trades.map((trade) => ({ original: trade, scored: trade }));
    }

    return trades.map((trade) => ({
        original: trade,
        scored: {
            ...trade,
            entryTime: shiftTradeTimeSeconds(trade.entryTime, shiftSec),
            exitTime: shiftTradeTimeSeconds(trade.exitTime, shiftSec),
        },
    }));
}

export function isSecondMarketPolymarketSupported(symbol: string, interval: string): boolean {
    return interval.trim().toLowerCase() === "1s" && normalizeSecondMarketChartSymbol(symbol) !== null;
}

export function isSecondMarketPolymarketScoringSupported(args: {
    symbol: string;
    interval: string;
    executionModel?: string;
}): boolean {
    return isSecondMarketPolymarketSupported(args.symbol, args.interval)
        && isPolymarketOneSecondSignalExitExecutionModel(args.executionModel);
}

function getTradeTimeRange(trades: readonly Trade[]): { startTs: number; endTs: number } | null {
    let startTs = Number.POSITIVE_INFINITY;
    let endTs = Number.NEGATIVE_INFINITY;
    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        const exitTs = parseTimeToUnixSeconds(trade.exitTime);
        if (entryTs !== null) {
            if (entryTs < startTs) startTs = entryTs;
            if (entryTs > endTs) endTs = entryTs;
        }
        if (exitTs !== null) {
            if (exitTs < startTs) startTs = exitTs;
            if (exitTs > endTs) endTs = exitTs;
        }
    }
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null;
    return {
        startTs,
        endTs,
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

function getFiniteProbability(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : null;
}

function inferYesProbabilityFromQuote(quote: PolymarketClob1sQuoteRow): number | null {
    const yesMid = getFiniteProbability(quote.yes_mid);
    if (yesMid !== null) return yesMid;
    const yesBid = getFiniteProbability(quote.yes_bid);
    const yesAsk = getFiniteProbability(quote.yes_ask);
    if (yesBid !== null && yesAsk !== null) return (yesBid + yesAsk) / 2;
    const noMid = getFiniteProbability(quote.no_mid);
    if (noMid !== null) return 1 - noMid;
    const noBid = getFiniteProbability(quote.no_bid);
    const noAsk = getFiniteProbability(quote.no_ask);
    if (noBid !== null && noAsk !== null) return 1 - ((noBid + noAsk) / 2);
    return null;
}

function maybeApplyInferredFinalOutcome(
    outcome: PolymarketOutcomeRow,
    quote: PolymarketClob1sQuoteRow,
    latestByKey: Map<string, { quoteTs: number; sourceTsMs: number }>
): void {
    const quoteTs = getClobQuoteTimeSec(quote);
    if (quoteTs === null) return;
    const ageSec = quote.event_end_ts - quoteTs;
    if (ageSec < 0 || ageSec > 1) return;

    const key = `${quote.series_id}:${quote.event_start_ts}:${quote.yes_token_id}`;
    const sourceTsMs = quote.source_ts_ms ?? 0;
    const latest = latestByKey.get(key);
    if (latest && (
        latest.quoteTs > quoteTs
        || (latest.quoteTs === quoteTs && latest.sourceTsMs >= sourceTsMs)
    )) {
        return;
    }

    latestByKey.set(key, { quoteTs, sourceTsMs });
    outcome.updated_at = Math.max(outcome.updated_at, quote.updated_at);

    const yesProbability = inferYesProbabilityFromQuote(quote);
    const resolvedOutcomeUp = yesProbability === null
        ? null
        : yesProbability > 0.5
            ? 1
            : yesProbability < 0.5
                ? 0
                : null;
    if (resolvedOutcomeUp === null) {
        outcome.resolved_outcome_up = 0;
        outcome.resolution_source = SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE;
        return;
    }

    outcome.resolved_outcome_up = resolvedOutcomeUp;
    outcome.resolution_source = "second_market_clob_final_quote";
}

function buildOutcomeRowsFromClobQuotes(quotes: readonly PolymarketClob1sQuoteRow[]): PolymarketOutcomeRow[] {
    const rows = new Map<string, PolymarketOutcomeRow>();
    const latestInferredFinalQuoteByKey = new Map<string, { quoteTs: number; sourceTsMs: number }>();
    for (const quote of quotes) {
        const key = `${quote.series_id}:${quote.event_start_ts}:${quote.yes_token_id}`;
        const existing = rows.get(key);
        const outcome = existing ?? {
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
        };
        if (!existing) rows.set(key, outcome);
        maybeApplyInferredFinalOutcome(outcome, quote, latestInferredFinalQuoteByKey);
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
        marketEntrySource: result.entrySource ?? "quote",
        marketEntryStatus: result.entryStatus ?? (scored ? "filled" : result.exitSource === "duplicate" ? "duplicate" : undefined),
        marketEntryFillTs: result.entryQuoteTs,
        marketEntryLimitPrice: result.entryLimitPrice,
        marketEntryImprovement: result.entryImprovement,
        marketEntryPrice: result.entryPrice,
        marketExitPrice: result.exitPrice,
        marketExitTs: result.exitQuoteTs ?? (
            result.exitSource === "resolution" ? result.outcome.event_end_ts : null
        ),
        marketExitSource: result.exitSource,
        marketExitTargetPrice: result.exitTargetPrice,
        marketExitStatus: result.exitStatus,
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
        entryPriceFilteredTrades: summary.entryPriceFilteredTrades || undefined,
        entryTimeFilteredTrades: summary.entryTimeFilteredTrades || undefined,
        evaluationMode,
        signalExitAllowMultipleTradesPerEvent: summary.allowMultipleTradesPerEvent,
        entryDelayBars: summary.entryDelayBars,
        backtestSlippageCents: summary.backtestSlippageCents,
        profitableTrades,
        losingTrades,
        neutralTrades,
        targetExitedTrades: summary.targetExitedTrades,
        protectionTakeProfitExitedTrades: summary.protectionTakeProfitExitedTrades,
        protectionStopLossExitedTrades: summary.protectionStopLossExitedTrades,
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
        limitEntryEnabled: summary.limitEntryEnabled,
        limitEntryMode: summary.limitEntryMode,
        limitEntryPriceCents: summary.limitEntryPriceCents,
        limitEntryOffsetCents: summary.limitEntryOffsetCents,
        limitEntryAttempts: summary.limitEntryAttempts,
        limitEntryFilledTrades: summary.limitEntryFilledTrades,
        limitEntryMissedTrades: summary.limitEntryMissedTrades,
        limitEntryNotTouchedTrades: summary.limitEntryNotTouchedTrades,
        limitEntryLastMinuteOnlyTrades: summary.limitEntryLastMinuteOnlyTrades,
        limitEntryMissingPriceTrades: summary.limitEntryMissingPriceTrades,
        limitEntryInvalidWindowTrades: summary.limitEntryInvalidWindowTrades,
        limitEntryFillRate: summary.limitEntryFillRate,
        avgLimitEntryWaitSec: summary.avgLimitEntryWaitSec,
        avgLimitEntryImprovement: summary.avgLimitEntryImprovement,
        limitExitEnabled: summary.limitExitEnabled,
        limitExitMode: summary.limitExitMode,
        limitExitPriceCents: summary.limitExitPriceCents,
        limitExitOffsetCents: summary.limitExitOffsetCents,
        limitExitFilledTrades: summary.limitExitFilledTrades,
        limitExitFallbackTrades: summary.limitExitFallbackTrades,
        limitExitUnreachableTrades: summary.limitExitUnreachableTrades,
        protectionTakeProfitEnabled: summary.protectionTakeProfitEnabled,
        protectionTakeProfitCents: summary.protectionTakeProfitCents,
        protectionStopLossEnabled: summary.protectionStopLossEnabled,
        protectionStopLossCents: summary.protectionStopLossCents,
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
        entryPriceFilteredPredictions: summary.entryPriceFilteredTrades || undefined,
        entryTimeFilteredPredictions: summary.entryTimeFilteredTrades || undefined,
        evaluationMode,
        signalExitAllowMultipleTradesPerEvent: summary.allowMultipleTradesPerEvent,
        entryDelayBars: summary.entryDelayBars,
        backtestSlippageCents: summary.backtestSlippageCents,
        targetExitedTrades: summary.targetExitedTrades,
        protectionTakeProfitExitedTrades: summary.protectionTakeProfitExitedTrades,
        protectionStopLossExitedTrades: summary.protectionStopLossExitedTrades,
        signalExitedTrades: summary.signalExitedTrades,
        resolvedTrades: summary.resolvedTrades,
        missingPriceTrades: summary.missingQuoteTrades,
        limitEntryEnabled: summary.limitEntryEnabled,
        limitEntryMode: summary.limitEntryMode,
        limitEntryPriceCents: summary.limitEntryPriceCents,
        limitEntryOffsetCents: summary.limitEntryOffsetCents,
        limitEntryAttempts: summary.limitEntryAttempts,
        limitEntryFilledTrades: summary.limitEntryFilledTrades,
        limitEntryMissedTrades: summary.limitEntryMissedTrades,
        limitEntryNotTouchedTrades: summary.limitEntryNotTouchedTrades,
        limitEntryLastMinuteOnlyTrades: summary.limitEntryLastMinuteOnlyTrades,
        limitEntryMissingPriceTrades: summary.limitEntryMissingPriceTrades,
        limitEntryInvalidWindowTrades: summary.limitEntryInvalidWindowTrades,
        limitEntryFillRate: summary.limitEntryFillRate,
        avgLimitEntryWaitSec: summary.avgLimitEntryWaitSec,
        avgLimitEntryImprovement: summary.avgLimitEntryImprovement,
        limitExitEnabled: summary.limitExitEnabled,
        limitExitMode: summary.limitExitMode,
        limitExitPriceCents: summary.limitExitPriceCents,
        limitExitOffsetCents: summary.limitExitOffsetCents,
        limitExitFilledTrades: summary.limitExitFilledTrades,
        limitExitFallbackTrades: summary.limitExitFallbackTrades,
        limitExitUnreachableTrades: summary.limitExitUnreachableTrades,
        protectionTakeProfitEnabled: summary.protectionTakeProfitEnabled,
        protectionTakeProfitCents: summary.protectionTakeProfitCents,
        protectionStopLossEnabled: summary.protectionStopLossEnabled,
        protectionStopLossCents: summary.protectionStopLossCents,
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
    apiBaseUrl?: string;
    includeGammaSnapshots?: boolean;
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
    const includeGammaSnapshots = args.includeGammaSnapshots !== false;
    const [outcomes, quoteResult, gammaSnapshots] = await Promise.all([
        loadPolymarketOutcomesForTimeRange(args.symbol, startTs, endTs, outcomeSymbol, outcomeInterval),
        loadSecondMarketClobQuotesWithStats({
            symbol: outcomeSymbol,
            seriesId,
            startTs,
            endTs,
            baseUrl: args.apiBaseUrl,
        }),
        includeGammaSnapshots
            ? loadSecondMarketGammaSnapshots({
                symbol: outcomeSymbol,
                seriesId,
                startTs,
                endTs,
                baseUrl: args.apiBaseUrl,
            }).catch(() => [])
            : Promise.resolve([]),
    ]);

    return {
        symbol,
        outcomeSymbol,
        seriesId,
        outcomeInterval,
        outcomes: mergeOutcomeRowsWithClobEvents(outcomes, quoteResult.quotes),
        quotes: quoteResult.quotes,
        quoteStats: quoteResult.stats,
        gammaSnapshots,
    };
}

export function evaluateSecondMarketBacktest(args: {
    result: Pick<BacktestResult, "trades">;
    context: SecondMarketEvaluationContext;
    trades?: readonly Trade[];
    executionModel?: string;
    polymarketExitMode?: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
    entryPriceFilterCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    entryDelayBars?: number;
    backtestSlippageCents?: number;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
    protection?: Partial<PolymarketProtectionSettingFields>;
}): SecondMarketEvaluationResult {
    const trades = [...(args.trades ?? args.result.trades)];
    const tradePairs = buildScoredTradePairs(trades, args.executionModel);
    const scoredToOriginal = new Map<Trade, Trade>(
        tradePairs.map((pair) => [pair.scored, pair.original] as const)
    );
    const evaluationMode = args.polymarketExitMode ?? "signal_exit_same_event";
    const evaluated = evaluateSecondMarketTrades({
        trades: tradePairs.map((pair) => pair.scored),
        outcomes: args.context.outcomes,
        quotes: args.context.quotes,
        evaluationMode,
        allowMultipleTradesPerEvent: isSameEventPolymarketExitMode(evaluationMode)
            ? args.polymarketSignalExitAllowMultipleTradesPerEvent
            : false,
        mode: "strict",
        fillSource: "bid_ask",
        entryPriceFilterCents: args.entryPriceFilterCents,
        entryCutoffEnabled: args.entryCutoffEnabled,
        entryCutoffSeconds: args.entryCutoffSeconds,
        entryDelayBars: args.entryDelayBars,
        backtestSlippageCents: args.backtestSlippageCents,
        limitEntry: args.limitEntry,
        protection: args.protection,
    });
    const tradeResults = evaluated.results.map((result) => ({
        ...result,
        trade: scoredToOriginal.get(result.trade) ?? result.trade,
    }));
    const annotatedByTrade = new Map<Trade, TradePolymarketOutcome>(
        tradeResults.map((result) => [result.trade, buildTradeAnnotation(result, evaluationMode)] as const)
    );
    const annotatedTrades = args.result.trades.map((trade) => ({
        ...trade,
        polymarketOutcome: annotatedByTrade.get(trade) ?? null,
    }));
    const polymarketSummary = summarizePolymarketResult({
        context: args.context,
        summary: evaluated.summary,
        tradeResults,
        tradeCount: trades.length,
        evaluationMode,
    });
    return {
        tradeResults,
        summary: evaluated.summary,
        polymarketSummary,
        polymarketEval: buildPolymarketEval({
            outcomes: args.context.outcomes,
            tradeResults,
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
    entryPriceFilterCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    entryDelayBars?: number;
    backtestSlippageCents?: number;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
    protection?: Partial<PolymarketProtectionSettingFields>;
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
        includeGammaSnapshots: false,
    });
    if (!context) return args.result;

    const evaluated = evaluateSecondMarketBacktest({
        result: args.result,
        context,
        executionModel: args.executionModel,
        polymarketExitMode: args.polymarketExitMode,
        polymarketSignalExitAllowMultipleTradesPerEvent: args.polymarketSignalExitAllowMultipleTradesPerEvent,
        entryPriceFilterCents: args.entryPriceFilterCents,
        entryCutoffEnabled: args.entryCutoffEnabled,
        entryCutoffSeconds: args.entryCutoffSeconds,
        entryDelayBars: args.entryDelayBars,
        backtestSlippageCents: args.backtestSlippageCents,
        limitEntry: args.limitEntry,
        protection: args.protection,
    });

    return {
        ...args.result,
        trades: evaluated.annotatedTrades,
        polymarketTradeSummary: evaluated.polymarketSummary,
    };
}
