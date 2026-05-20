import { parseTimeToUnixSeconds } from "./time-normalization";
import { findContainingEvent } from "./polymarket-1m-5m-bridge";
import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";
import {
    findEntryFill,
    findSignalExitFill,
    indexPricePointsByEvent,
    type EventPriceIndex,
} from "./polymarket-price-points";
import { resolvePolymarketEntryCutoff } from "./polymarket-entry-cutoff";
import { isPolymarketEntryPriceFiltered } from "./polymarket-entry-price-filter";
import {
    applyPolymarketBacktestEntrySlippage,
    applyPolymarketBacktestExitSlippage,
    clampPolymarketBacktestSlippageCents,
} from "./polymarket-backtest-slippage";
import {
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    findPostSignalLimitEntryFill,
    findPostSignalLimitExitFill,
    resolvePolymarketLimitExitTargetPrice,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
    type PolymarketPostSignalLimitEntrySettings,
} from "./polymarket-post-signal-limit-entry";
import type { Trade } from "./types/strategies";
import type {
    BacktestPolymarketTradeSummary,
    PolymarketMarketEntrySource,
    PolymarketMarketEntryStatus,
    PolymarketOutcomeRow,
    TradePolymarketOutcome,
} from "./types/polymarket-outcomes";
import { buildPolymarketOutcomeBase } from "./polymarket-outcome-annotation";

export interface SignalExitEvalInput {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    pricePoints?: readonly PolymarketPricePoint[];
    priceIndex?: EventPriceIndex;
    outcomeByEntryTs?: ReadonlyMap<number, PolymarketOutcomeRow | null>;
    allowMultipleTradesPerEvent?: boolean;
    entryPriceFilterCents?: number;
    backtestSlippageCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
}

export interface SignalExitTradeResult {
    trade: Trade;
    outcome: PolymarketOutcomeRow | null;
    side: "yes" | "no" | null;
    entrySource?: PolymarketMarketEntrySource;
    entryStatus?: PolymarketMarketEntryStatus;
    entryMode?: PolymarketPostSignalLimitEntrySettings["priceMode"];
    entryOffsetCents?: number;
    entryPrice: number | null;
    entryFillTs?: number | null;
    entryLimitPrice?: number | null;
    entryImprovement?: number | null;
    exitPrice: number | null;
    exitTs: number | null;
    exitSource: "target" | "signal" | "resolution" | "missing" | "duplicate" | "entry_price_filtered" | "entry_time_filtered" | "no_event";
    exitTargetPrice?: number | null;
    exitStatus?: "filled" | "not_touched" | "missing_price_points" | "unreachable";
    pnl: number | null;
    isProfitable: boolean | null;
    actualOutcomeUp: 0 | 1 | null;
    isWin: boolean | null;
}

export interface SignalExitSummary {
    scoredTrades: number;
    missingPriceTrades: number;
    missingOutcomeTrades: number;
    duplicateTradesIgnored: number;
    entryPriceFilteredTrades: number;
    entryTimeFilteredTrades: number;
    unscoredTrades: number;
    profitableTrades: number;
    losingTrades: number;
    neutralTrades: number;
    targetExitedTrades: number;
    signalExitedTrades: number;
    resolvedTrades: number;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    expectancy: number;
    avgEntryPrice: number;
    avgExitPrice: number;
    backtestSlippageCents?: number;
    totalPnl: number;
    limitEntryEnabled?: boolean;
    allowMultipleTradesPerEvent?: boolean;
    limitEntryMode?: PolymarketPostSignalLimitEntrySettings["priceMode"];
    limitEntryPriceCents?: number;
    limitEntryOffsetCents?: number;
    limitEntryAttempts?: number;
    limitEntryFilledTrades?: number;
    limitEntryMissedTrades?: number;
    limitEntryNotTouchedTrades?: number;
    limitEntryLastMinuteOnlyTrades?: number;
    limitEntryMissingPriceTrades?: number;
    limitEntryInvalidWindowTrades?: number;
    limitEntryFillRate?: number;
    avgLimitEntryWaitSec?: number;
    avgLimitEntryImprovement?: number;
    limitExitEnabled?: boolean;
    limitExitMode?: PolymarketPostSignalLimitEntrySettings["exitMode"];
    limitExitPriceCents?: number;
    limitExitOffsetCents?: number;
    limitExitFilledTrades?: number;
    limitExitFallbackTrades?: number;
    limitExitUnreachableTrades?: number;
}

export function buildSignalExitPolymarketTradeSummary(args: {
    seriesId: string;
    outcomeSymbol?: string | null;
    outcomeInterval?: BacktestPolymarketTradeSummary["outcomeInterval"];
    outcomeRowsLoaded: number;
    summary: SignalExitSummary;
}): BacktestPolymarketTradeSummary {
    const { summary } = args;
    return {
        seriesId: args.seriesId,
        outcomeSymbol: args.outcomeSymbol ?? undefined,
        outcomeInterval: args.outcomeInterval,
        outcomeRowsLoaded: args.outcomeRowsLoaded,
        scoredTrades: summary.scoredTrades,
        missingOutcomeTrades: summary.missingOutcomeTrades,
        unscoredTrades: summary.unscoredTrades,
        duplicateTradesIgnored: summary.duplicateTradesIgnored > 0 ? summary.duplicateTradesIgnored : undefined,
        entryPriceFilteredTrades: summary.entryPriceFilteredTrades > 0 ? summary.entryPriceFilteredTrades : undefined,
        entryTimeFilteredTrades: summary.entryTimeFilteredTrades > 0 ? summary.entryTimeFilteredTrades : undefined,
        evaluationMode: "signal_exit_same_event",
        signalExitAllowMultipleTradesPerEvent: summary.allowMultipleTradesPerEvent,
        profitableTrades: summary.profitableTrades,
        losingTrades: summary.losingTrades,
        neutralTrades: summary.neutralTrades,
        targetExitedTrades: summary.targetExitedTrades,
        signalExitedTrades: summary.signalExitedTrades,
        resolvedTrades: summary.resolvedTrades,
        missingPriceTrades: summary.missingPriceTrades,
        netPnl: summary.netPnl,
        grossProfit: summary.grossProfit,
        grossLoss: summary.grossLoss,
        profitFactor: summary.profitFactor,
        expectancy: summary.expectancy,
        avgEntryPrice: summary.avgEntryPrice,
        avgExitPrice: summary.avgExitPrice,
        backtestSlippageCents: summary.backtestSlippageCents,
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
    };
}

export function indexSignalExitOutcomesByEntryTs(
    entryTimestamps: readonly number[],
    outcomes: readonly PolymarketOutcomeRow[]
): Map<number, PolymarketOutcomeRow | null> {
    const index = new Map<number, PolymarketOutcomeRow | null>();
    const sortedUniqueTimestamps = Array.from(new Set(
        entryTimestamps.filter((value) => Number.isFinite(value))
    )).sort((left, right) => left - right);

    let outcomeIndex = 0;
    for (const entryTs of sortedUniqueTimestamps) {
        while (outcomeIndex < outcomes.length && entryTs >= outcomes[outcomeIndex]!.event_end_ts) {
            outcomeIndex++;
        }

        const outcome = outcomeIndex < outcomes.length
            && entryTs >= outcomes[outcomeIndex]!.event_start_ts
            ? outcomes[outcomeIndex]!
            : null;
        index.set(entryTs, outcome);
    }

    return index;
}

export function indexSignalExitOutcomesForTrades(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): Map<number, PolymarketOutcomeRow | null> {
    return indexSignalExitOutcomesByEntryTs(
        trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null),
        outcomes
    );
}

export function evaluateSignalExitTrades(
    input: SignalExitEvalInput
): { results: SignalExitTradeResult[]; summary: SignalExitSummary } {
    const { trades, outcomes } = input;
    const priceIndex = input.priceIndex ?? (
        input.pricePoints ? indexPricePointsByEvent(input.pricePoints) : null
    );
    if (!priceIndex) {
        throw new Error("evaluateSignalExitTrades requires pricePoints or a prebuilt priceIndex.");
    }
    const results: SignalExitTradeResult[] = [];

    const allowMultipleTradesPerEvent = input.allowMultipleTradesPerEvent === true;
    const seenEvents = new Set<number>();
    const limitPriceByEventStart = new Map<number, number>();
    const limitEntryEnabled = input.limitEntry?.enabled === true;
    const limitEntryPriceCents = clampPolymarketPostSignalLimitEntryPriceCents(input.limitEntry?.priceCents);
    const fixedLimitPrice = limitEntryPriceCents / 100;
    const limitEntryMode = resolvePolymarketPostSignalLimitEntryMode(input.limitEntry?.priceMode);
    const limitEntryOffsetCents = clampPolymarketPostSignalLimitOffsetCents(input.limitEntry?.offsetCents);
    const limitEntryOffsetPrice = limitEntryOffsetCents / 100;
    const limitExitEnabled = limitEntryEnabled && input.limitEntry?.exitEnabled === true;
    const backtestSlippageCents = clampPolymarketBacktestSlippageCents(input.backtestSlippageCents, 0);

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const outcome = input.outcomeByEntryTs?.has(entryTs)
            ? (input.outcomeByEntryTs.get(entryTs) ?? null)
            : findContainingEvent(entryTs, outcomes);
        if (!outcome) {
            results.push({
                trade,
                outcome: null,
                side: null,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: null,
                exitPrice: null,
                exitTs: null,
                exitSource: "no_event",
                pnl: null,
                isProfitable: null,
                actualOutcomeUp: null,
                isWin: null,
            });
            continue;
        }

        if (!allowMultipleTradesPerEvent && seenEvents.has(outcome.event_start_ts)) {
            results.push({
                trade,
                outcome,
                side: trade.type === "long" ? "yes" : "no",
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "duplicate" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: null,
                entryFillTs: null,
                entryLimitPrice: limitEntryEnabled ? limitPriceByEventStart.get(outcome.event_start_ts) ?? fixedLimitPrice : null,
                entryImprovement: null,
                exitPrice: null,
                exitTs: null,
                exitSource: "duplicate",
                pnl: null,
                isProfitable: null,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin: null,
            });
            continue;
        }
        const side: "yes" | "no" = trade.type === "long" ? "yes" : "no";
        const isWin = side === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        const eventPoints = priceIndex.pointsByEventStart.get(outcome.event_start_ts) ?? [];
        const entryCutoff = resolvePolymarketEntryCutoff({
            entryTimeSec: entryTs,
            eventEndTs: outcome.event_end_ts,
            enabled: input.entryCutoffEnabled,
            cutoffSeconds: input.entryCutoffSeconds,
        });
        if (!entryCutoff.allowed) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: null,
                entryFillTs: null,
                entryLimitPrice: limitEntryEnabled ? fixedLimitPrice : null,
                entryImprovement: null,
                exitPrice: null,
                exitTs: null,
                exitSource: "entry_time_filtered",
                pnl: null,
                isProfitable: null,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin: null,
            });
            continue;
        }

        const exitTsRaw = trade.exitReason === "signal"
            ? parseTimeToUnixSeconds(trade.exitTime)
            : null;
        const signalExitTs = exitTsRaw !== null && exitTsRaw < outcome.event_end_ts
            ? exitTsRaw
            : null;
        let entryPrice: number | null = null;
        let entryFillTs: number | null = null;
        let entryImprovement: number | null = null;

        if (limitEntryEnabled) {
            const limitEntryFill = findPostSignalLimitEntryFill(eventPoints, {
                side,
                startTs: entryTs,
                eventEndTs: outcome.event_end_ts,
                limitPrice: fixedLimitPrice,
                priceMode: limitEntryMode,
                offsetPrice: limitEntryOffsetPrice,
                latestAllowedTs: signalExitTs,
            });
            const resolvedLimitPrice = limitEntryFill.limitPrice ?? fixedLimitPrice;
            limitPriceByEventStart.set(outcome.event_start_ts, resolvedLimitPrice);
            if (limitEntryFill.status !== "filled") {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "limit",
                    entryStatus: limitEntryFill.status,
                    entryMode: limitEntryMode,
                    entryOffsetCents: limitEntryOffsetCents,
                    entryPrice: null,
                    entryFillTs: null,
                    entryLimitPrice: resolvedLimitPrice,
                    entryImprovement: null,
                    exitPrice: null,
                    exitTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                    actualOutcomeUp: outcome.resolved_outcome_up,
                    isWin,
                });
                continue;
            }
            entryPrice = limitEntryFill.fillPrice;
            entryFillTs = limitEntryFill.fillTs;
            entryImprovement = limitEntryFill.entryImprovement;
        } else {
            const quoteEntryFill = findEntryFill(eventPoints, entryTs, side);
            if (!quoteEntryFill) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "quote",
                    entryPrice: null,
                    exitPrice: null,
                    exitTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                    actualOutcomeUp: outcome.resolved_outcome_up,
                    isWin,
                });
                continue;
            }
            entryPrice = applyPolymarketBacktestEntrySlippage(quoteEntryFill.price, backtestSlippageCents);
            entryFillTs = quoteEntryFill.ts;
        }

        if (isPolymarketEntryPriceFiltered(entryPrice, input.entryPriceFilterCents)) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice,
                entryFillTs,
                entryLimitPrice: limitEntryEnabled ? entryPrice : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitTs: null,
                exitSource: "entry_price_filtered",
                pnl: null,
                isProfitable: null,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin: null,
            });
            continue;
        }

        let exitPrice: number | null = null;
        let exitTs: number | null = null;
        let exitSource: "target" | "signal" | "resolution" | "missing" = "resolution";
        let exitTargetPrice: number | null = null;
        let exitStatus: SignalExitTradeResult["exitStatus"];
        let signalExitAttempted = false;
        const targetExit = limitExitEnabled && entryPrice !== null && entryFillTs !== null
            ? (() => {
                exitTargetPrice = resolvePolymarketLimitExitTargetPrice(entryPrice, input.limitEntry!);
                return findPostSignalLimitExitFill(eventPoints, {
                    side,
                    startTs: entryFillTs,
                    eventEndTs: outcome.event_end_ts,
                    targetPrice: exitTargetPrice,
                });
            })()
            : null;

        if (trade.exitReason === "signal") {
            if (exitTsRaw !== null && exitTsRaw < outcome.event_end_ts) {
                signalExitAttempted = true;
                const exitFill = findSignalExitFill(eventPoints, exitTsRaw, side);
                // Sparse event history can legitimately leave one quote as both
                // the first fill after entry and the latest known quote before
                // the chart exit. Treat that as a flat same-event exit instead
                // of dropping the first trade and letting a later trade claim
                // the event.
                const targetFillsFirst = targetExit?.status === "filled"
                    && targetExit.fillTs !== null
                    && targetExit.fillTs <= exitTsRaw;
                if (targetFillsFirst) {
                    exitPrice = targetExit.fillPrice;
                    exitTs = targetExit.fillTs;
                    exitSource = "target";
                    exitStatus = targetExit.status;
                } else if (exitFill && entryFillTs !== null && exitFill.ts >= entryFillTs) {
                    const rawExitPrice = exitFill.ts === entryFillTs && entryPrice !== null && backtestSlippageCents <= 0
                        ? entryPrice
                        : exitFill.price;
                    exitPrice = applyPolymarketBacktestExitSlippage(rawExitPrice, backtestSlippageCents);
                    exitTs = exitFill.ts;
                    exitSource = "signal";
                    exitStatus = targetExit?.status;
                } else {
                    exitSource = "missing";
                    exitStatus = targetExit?.status;
                }
            }
        }

        if (exitSource === "missing" && signalExitAttempted) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice,
                entryFillTs,
                entryLimitPrice: limitEntryEnabled ? entryPrice : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitTs: null,
                exitSource: "missing",
                exitTargetPrice,
                exitStatus,
                pnl: null,
                isProfitable: null,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin,
            });
            continue;
        }

        if (exitSource !== "target" && !signalExitAttempted && targetExit?.status === "filled") {
            exitPrice = targetExit.fillPrice;
            exitTs = targetExit.fillTs;
            exitSource = "target";
            exitStatus = targetExit.status;
        }

        if (exitSource !== "signal") {
            if (exitSource !== "target") {
                if (outcome.resolved_outcome_up === 1) {
                    exitPrice = side === "yes" ? 1 : 0;
                } else {
                    exitPrice = side === "yes" ? 0 : 1;
                }
                exitTs = outcome.event_end_ts;
                exitSource = "resolution";
                exitStatus = targetExit?.status;
            }
        }

        const pnl = exitPrice !== null && entryPrice !== null ? exitPrice - entryPrice : null;
        const isProfitable = pnl === null
            ? null
            : pnl > 0
                ? true
                : pnl < 0
                    ? false
                    : null;

        // Missing-price and unfilled limit attempts do not consume the event;
        // the first scored trade claims it.
        if (!allowMultipleTradesPerEvent) {
            seenEvents.add(outcome.event_start_ts);
        }
        results.push({
            trade,
            outcome,
            side,
            entrySource: limitEntryEnabled ? "limit" : "quote",
            entryStatus: limitEntryEnabled ? "filled" : undefined,
            entryMode: limitEntryEnabled ? limitEntryMode : undefined,
            entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
            entryPrice,
            entryFillTs,
            entryLimitPrice: limitEntryEnabled ? entryPrice : null,
            entryImprovement: limitEntryEnabled ? entryImprovement : null,
            exitPrice,
            exitTs,
            exitSource,
            exitTargetPrice,
            exitStatus,
            pnl,
            isProfitable,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
        });
    }

    const summary = buildSignalExitSummary(
        results,
        input.limitEntry,
        allowMultipleTradesPerEvent,
        backtestSlippageCents
    );
    return { results, summary };
}

function buildSignalExitSummary(
    results: readonly SignalExitTradeResult[],
    settings?: PolymarketPostSignalLimitEntrySettings,
    allowMultipleTradesPerEvent = false,
    backtestSlippageCents = 0
): SignalExitSummary {
    let scoredTrades = 0;
    let missingPriceTrades = 0;
    let missingOutcomeTrades = 0;
    let duplicateTradesIgnored = 0;
    let entryPriceFilteredTrades = 0;
    let entryTimeFilteredTrades = 0;
    let profitableTrades = 0;
    let losingTrades = 0;
    let neutralTrades = 0;
    let targetExitedTrades = 0;
    let signalExitedTrades = 0;
    let resolvedTrades = 0;
    let netPnl = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalEntryPrice = 0;
    let totalExitPrice = 0;
    let pricedCount = 0;
    let limitEntryAttempts = 0;
    let limitEntryFilledTrades = 0;
    let limitEntryNotTouchedTrades = 0;
    let limitEntryLastMinuteOnlyTrades = 0;
    let limitEntryMissingPriceTrades = 0;
    let limitEntryInvalidWindowTrades = 0;
    let totalLimitEntryWaitSec = 0;
    let totalLimitEntryImprovement = 0;
    let limitEntryWaitCount = 0;
    let limitEntryImprovementCount = 0;
    let limitExitFilledTrades = 0;
    let limitExitFallbackTrades = 0;
    let limitExitUnreachableTrades = 0;
    const limitEntryEnabled = results.some((r) => r.entrySource === "limit");
    const limitEntryPriceCents = results
        .map((r) => r.entryLimitPrice)
        .find((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limitExitEnabled = limitEntryEnabled && settings?.exitEnabled === true;

    for (const r of results) {
        if (r.entrySource === "limit" && r.entryStatus && r.entryStatus !== "duplicate") {
            limitEntryAttempts++;
            if (r.entryStatus === "filled") {
                limitEntryFilledTrades++;
                const entryTs = parseTimeToUnixSeconds(r.trade.entryTime);
                if (entryTs !== null && typeof r.entryFillTs === "number" && Number.isFinite(r.entryFillTs)) {
                    totalLimitEntryWaitSec += Math.max(0, r.entryFillTs - entryTs);
                    limitEntryWaitCount++;
                }
                if (typeof r.entryImprovement === "number" && Number.isFinite(r.entryImprovement)) {
                    totalLimitEntryImprovement += r.entryImprovement;
                    limitEntryImprovementCount++;
                }
            } else if (r.entryStatus === "not_touched") {
                limitEntryNotTouchedTrades++;
            } else if (r.entryStatus === "last_minute_only") {
                limitEntryLastMinuteOnlyTrades++;
            } else if (r.entryStatus === "missing_price_points") {
                limitEntryMissingPriceTrades++;
            } else if (r.entryStatus === "invalid_window") {
                limitEntryInvalidWindowTrades++;
            }
        }

        if (r.exitSource === "missing") {
            if (
                r.entrySource !== "limit"
                || r.entryStatus === "filled"
                || r.entryStatus === "missing_price_points"
                || !r.entryStatus
            ) {
                missingPriceTrades++;
            }
            continue;
        }
        if (r.exitSource === "duplicate") {
            duplicateTradesIgnored++;
            continue;
        }
        if (r.exitSource === "entry_price_filtered") {
            entryPriceFilteredTrades++;
            continue;
        }
        if (r.exitSource === "entry_time_filtered") {
            entryTimeFilteredTrades++;
            continue;
        }
        if (r.exitSource === "no_event") {
            missingOutcomeTrades++;
            continue;
        }

        scoredTrades++;

        if (r.exitSource === "target") targetExitedTrades++;
        else if (r.exitSource === "signal") signalExitedTrades++;
        else resolvedTrades++;

        if (limitExitEnabled && r.entrySource === "limit" && r.entryStatus === "filled") {
            if (r.exitSource === "target") {
                limitExitFilledTrades++;
            } else {
                limitExitFallbackTrades++;
                if (r.exitStatus === "unreachable") {
                    limitExitUnreachableTrades++;
                }
            }
        }

        if (r.pnl !== null) {
            pricedCount++;
            netPnl += r.pnl;
            totalEntryPrice += r.entryPrice ?? 0;
            totalExitPrice += r.exitPrice ?? 0;
            if (r.pnl > 0) {
                profitableTrades++;
                grossProfit += r.pnl;
            } else if (r.pnl < 0) {
                losingTrades++;
                grossLoss += Math.abs(r.pnl);
            } else {
                neutralTrades++;
            }
        }
    }

    const limitEntryMissedTrades = Math.max(0, limitEntryAttempts - limitEntryFilledTrades);
    const limitEntryMissesWithoutMissingPrices = Math.max(0, limitEntryMissedTrades - limitEntryMissingPriceTrades);

    return {
        scoredTrades,
        missingPriceTrades,
        missingOutcomeTrades,
        duplicateTradesIgnored,
        entryPriceFilteredTrades,
        entryTimeFilteredTrades,
        unscoredTrades: missingPriceTrades + missingOutcomeTrades + duplicateTradesIgnored + entryPriceFilteredTrades + entryTimeFilteredTrades + limitEntryMissesWithoutMissingPrices,
        profitableTrades,
        losingTrades,
        neutralTrades,
        targetExitedTrades,
        signalExitedTrades,
        resolvedTrades,
        netPnl,
        grossProfit,
        grossLoss,
        profitFactor: grossProfit > 0 ? (grossLoss > 0 ? grossProfit / grossLoss : Infinity) : 0,
        expectancy: pricedCount > 0 ? netPnl / pricedCount : 0,
        avgEntryPrice: pricedCount > 0 ? totalEntryPrice / pricedCount : 0,
        avgExitPrice: pricedCount > 0 ? totalExitPrice / pricedCount : 0,
        backtestSlippageCents: backtestSlippageCents > 0 ? backtestSlippageCents : undefined,
        totalPnl: netPnl,
        limitEntryEnabled: limitEntryEnabled || undefined,
        allowMultipleTradesPerEvent: allowMultipleTradesPerEvent || undefined,
        limitEntryMode: limitEntryEnabled ? resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) : undefined,
        limitEntryPriceCents: limitEntryEnabled && resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) === "fixed_price"
            ? clampPolymarketPostSignalLimitEntryPriceCents(settings?.priceCents)
            : limitEntryEnabled && typeof limitEntryPriceCents === "number"
                ? Math.round(limitEntryPriceCents * 100)
                : undefined,
        limitEntryOffsetCents: limitEntryEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.offsetCents) : undefined,
        limitEntryAttempts: limitEntryEnabled ? limitEntryAttempts : undefined,
        limitEntryFilledTrades: limitEntryEnabled ? limitEntryFilledTrades : undefined,
        limitEntryMissedTrades: limitEntryEnabled ? limitEntryMissedTrades : undefined,
        limitEntryNotTouchedTrades: limitEntryEnabled ? limitEntryNotTouchedTrades : undefined,
        limitEntryLastMinuteOnlyTrades: limitEntryEnabled ? limitEntryLastMinuteOnlyTrades : undefined,
        limitEntryMissingPriceTrades: limitEntryEnabled ? limitEntryMissingPriceTrades : undefined,
        limitEntryInvalidWindowTrades: limitEntryEnabled ? limitEntryInvalidWindowTrades : undefined,
        limitEntryFillRate: limitEntryEnabled && limitEntryAttempts > 0 ? limitEntryFilledTrades / limitEntryAttempts : undefined,
        avgLimitEntryWaitSec: limitEntryEnabled && limitEntryWaitCount > 0 ? totalLimitEntryWaitSec / limitEntryWaitCount : undefined,
        avgLimitEntryImprovement: limitEntryEnabled && limitEntryImprovementCount > 0 ? totalLimitEntryImprovement / limitEntryImprovementCount : undefined,
        limitExitEnabled: limitExitEnabled || undefined,
        limitExitMode: limitExitEnabled ? resolvePolymarketPostSignalLimitExitMode(settings?.exitMode) : undefined,
        limitExitPriceCents: limitExitEnabled ? clampPolymarketPostSignalLimitExitPriceCents(settings?.exitPriceCents) : undefined,
        limitExitOffsetCents: limitExitEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.exitOffsetCents) : undefined,
        limitExitFilledTrades: limitExitEnabled ? limitExitFilledTrades : undefined,
        limitExitFallbackTrades: limitExitEnabled ? limitExitFallbackTrades : undefined,
        limitExitUnreachableTrades: limitExitEnabled ? limitExitUnreachableTrades : undefined,
    };
}

function buildSignalExitOutcomeAnnotation(
    result: SignalExitTradeResult,
    overrides: Pick<
        TradePolymarketOutcome,
        | "isWin"
        | "isProfitable"
        | "marketEntryPrice"
        | "marketExitPrice"
        | "marketExitTs"
        | "marketExitSource"
        | "marketPnl"
    >
): TradePolymarketOutcome {
    const outcome = result.outcome!;
    const prediction = result.side as "yes" | "no";
    return {
        ...buildPolymarketOutcomeBase({ outcome, prediction, isWin: overrides.isWin ?? null }),
        evaluationMode: "signal_exit_same_event",
        isProfitable: overrides.isProfitable ?? null,
        marketEntrySource: result.entrySource,
        marketEntryStatus: result.entryStatus,
        marketEntryFillTs: result.entryFillTs,
        marketEntryLimitPrice: result.entryLimitPrice,
        marketEntryImprovement: result.entryImprovement,
        marketEntryPrice: overrides.marketEntryPrice,
        marketExitPrice: overrides.marketExitPrice,
        marketExitTs: overrides.marketExitTs,
        marketExitSource: overrides.marketExitSource,
        marketExitTargetPrice: result.exitTargetPrice,
        marketExitStatus: result.exitStatus,
        marketPnl: overrides.marketPnl,
    };
}

export function buildTradeAnnotationFromSignalExitResult(
    result: SignalExitTradeResult
): TradePolymarketOutcome | null {
    if (result.exitSource === "missing") {
        if (result.entrySource === "limit" && result.outcome && result.entryStatus && result.entryStatus !== "filled") {
            return buildSignalExitOutcomeAnnotation(result, {
                isWin: null,
                isProfitable: null,
                marketEntryPrice: null,
                marketExitPrice: null,
                marketExitTs: null,
                marketExitSource: "missing",
                marketPnl: null,
            });
        }
        return null;
    }

    if (result.exitSource === "no_event") {
        return {
            eventStartTs: 0,
            eventEndTs: 0,
            eventSlug: "",
            marketSlug: "",
            prediction: (result.side ?? "yes") as "yes" | "no",
            actualOutcomeUp: 0,
            isWin: null,
            evaluationMode: "signal_exit_same_event",
            isProfitable: null,
            marketEntrySource: result.entrySource,
            marketEntryStatus: result.entryStatus,
            marketEntryFillTs: result.entryFillTs,
            marketEntryLimitPrice: result.entryLimitPrice,
            marketEntryImprovement: result.entryImprovement,
            marketEntryPrice: null,
            marketExitPrice: null,
            marketExitTs: null,
            marketExitSource: "no_event",
            marketExitTargetPrice: result.exitTargetPrice,
            marketExitStatus: result.exitStatus,
            marketPnl: null,
        };
    }

    if (result.exitSource === "duplicate") {
        return buildSignalExitOutcomeAnnotation(result, {
            isWin: null,
            isProfitable: null,
            marketEntryPrice: null,
            marketExitPrice: null,
            marketExitTs: null,
            marketExitSource: "duplicate",
            marketPnl: null,
        });
    }

    if (result.exitSource === "entry_price_filtered") {
        return buildSignalExitOutcomeAnnotation(result, {
            isWin: null,
            isProfitable: null,
            marketEntryPrice: result.entryPrice,
            marketExitPrice: null,
            marketExitTs: null,
            marketExitSource: "entry_price_filtered",
            marketPnl: null,
        });
    }

    if (result.exitSource === "entry_time_filtered") {
        return buildSignalExitOutcomeAnnotation(result, {
            isWin: null,
            isProfitable: null,
            marketEntryPrice: null,
            marketExitPrice: null,
            marketExitTs: null,
            marketExitSource: "entry_time_filtered",
            marketPnl: null,
        });
    }

    return buildSignalExitOutcomeAnnotation(result, {
        isWin: result.isWin,
        isProfitable: result.isProfitable,
        marketEntryPrice: result.entryPrice,
        marketExitPrice: result.exitPrice,
        marketExitTs: result.exitTs,
        marketExitSource: result.exitSource as TradePolymarketOutcome["marketExitSource"],
        marketPnl: result.pnl,
    });
}
