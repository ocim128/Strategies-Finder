import { parseTimeToUnixSeconds } from "../time-normalization";
import { isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";
import { resolvePolymarketEntryCutoff } from "../polymarket-entry-cutoff";
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
} from "../polymarket-post-signal-limit-entry";
import type { Trade } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";
import type { PolymarketPricePoint } from "../local-sqlite-polymarket-api";
import {
    DEFAULT_MAX_QUOTE_AGE_SEC,
    findContainingPolymarketEvent,
    getClobQuoteTimeSec,
    getClobSidePrice,
} from "./alignment";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketAlignmentMode,
    SecondMarketBacktestSummary,
    SecondMarketFillSource,
    SecondMarketSide,
    SecondMarketTradeResult,
} from "./types";

type Fill = {
    price: number;
    quoteTs: number;
};

export const SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE = "second_market_clob_unresolved";

function isFillAgeUsable(ageSec: number, mode: SecondMarketAlignmentMode, maxQuoteAgeSec: number): boolean {
    if (ageSec < 0) return false;
    return mode === "strict" ? ageSec === 0 : ageSec <= maxQuoteAgeSec;
}

function findQuoteFill(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
    fillTs: number;
    side: SecondMarketSide;
    orderSide: "buy" | "sell";
    quotes: readonly PolymarketClob1sQuoteRow[];
    mode: SecondMarketAlignmentMode;
    maxQuoteAgeSec: number;
    fillSource: SecondMarketFillSource;
}): Fill | null {
    let best: { quote: PolymarketClob1sQuoteRow; quoteTs: number } | null = null;
    for (const quote of args.quotes) {
        if (quote.series_id !== args.seriesId) continue;
        if (quote.event_start_ts !== args.eventStartTs) continue;
        if (quote.yes_token_id !== args.yesTokenId) continue;
        if (args.noTokenId && quote.no_token_id !== args.noTokenId) continue;
        const quoteTs = getClobQuoteTimeSec(quote);
        if (quoteTs === null || quoteTs > args.fillTs) continue;
        if (!best || quoteTs > best.quoteTs || (
            quoteTs === best.quoteTs && (quote.source_ts_ms ?? 0) > (best.quote.source_ts_ms ?? 0)
        )) {
            best = { quote, quoteTs };
        }
    }

    if (!best) return null;
    const ageSec = args.fillTs - best.quoteTs;
    if (!isFillAgeUsable(ageSec, args.mode, args.maxQuoteAgeSec)) return null;
    const price = getClobSidePrice(best.quote, args.side, args.orderSide, args.fillSource);
    return price === null ? null : { price, quoteTs: best.quoteTs };
}

function buildClobPricePoints(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
    quotes: readonly PolymarketClob1sQuoteRow[];
    orderSide: "buy" | "sell";
    fillSource: SecondMarketFillSource;
}): PolymarketPricePoint[] {
    const pointByTs = new Map<number, { point: PolymarketPricePoint; sourceTsMs: number }>();
    for (const quote of args.quotes) {
        if (quote.series_id !== args.seriesId) continue;
        if (quote.event_start_ts !== args.eventStartTs) continue;
        if (quote.yes_token_id !== args.yesTokenId) continue;
        if (args.noTokenId && quote.no_token_id !== args.noTokenId) continue;
        const quoteTs = getClobQuoteTimeSec(quote);
        if (quoteTs === null) continue;
        const sourceTsMs = quote.source_ts_ms ?? 0;
        const existing = pointByTs.get(quoteTs);
        if (existing && existing.sourceTsMs >= sourceTsMs) {
            continue;
        }
        pointByTs.set(quoteTs, {
            sourceTsMs,
            point: {
                series_id: quote.series_id,
                event_start_ts: quote.event_start_ts,
                event_end_ts: quote.event_end_ts,
                market_slug: quote.market_slug,
                yes_token_id: quote.yes_token_id,
                no_token_id: quote.no_token_id,
                ts: quoteTs,
                yes_price: getClobSidePrice(quote, "yes", args.orderSide, args.fillSource),
                no_price: getClobSidePrice(quote, "no", args.orderSide, args.fillSource),
                updated_at: quote.updated_at,
            },
        });
    }
    return [...pointByTs.values()]
        .map((entry) => entry.point)
        .sort((left, right) => left.ts - right.ts);
}

function resolveResolutionExitPrice(outcome: PolymarketOutcomeRow, side: SecondMarketSide): number | null {
    if (outcome.resolution_source === SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE) {
        return null;
    }
    if (outcome.resolved_outcome_up === 1) {
        return side === "yes" ? 1 : 0;
    }
    return side === "yes" ? 0 : 1;
}

function buildSummary(
    results: readonly SecondMarketTradeResult[],
    evaluationMode: PolymarketExitMode,
    settings?: PolymarketPostSignalLimitEntrySettings,
    allowMultipleTradesPerEvent = false
): SecondMarketBacktestSummary {
    const scored = results.filter((result) => result.pnl !== null);
    const grossProfit = scored.reduce((sum, result) => sum + Math.max(0, result.pnl ?? 0), 0);
    const grossLoss = Math.abs(scored.reduce((sum, result) => sum + Math.min(0, result.pnl ?? 0), 0));
    const entryPrices = scored.map((result) => result.entryPrice).filter((value): value is number => value !== null);
    const exitPrices = scored.map((result) => result.exitPrice).filter((value): value is number => value !== null);
    const exactEntries = scored.filter((result) => {
        const entryTs = parseTimeToUnixSeconds(result.trade.entryTime);
        return entryTs !== null && result.entryQuoteTs === entryTs;
    }).length;
    const limitEntryEnabled = results.some((result) => result.entrySource === "limit");
    const limitEntryAttempts = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus !== undefined
        && result.entryStatus !== "duplicate"
    ).length;
    const limitEntryFilledTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "filled"
    ).length;
    const limitEntryMissedTrades = Math.max(0, limitEntryAttempts - limitEntryFilledTrades);
    const limitEntryMissingPriceTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "missing_price_points"
    ).length;
    const limitEntryWaits = results
        .filter((result) => result.entrySource === "limit" && result.entryStatus === "filled")
        .map((result) => {
            const entryTs = parseTimeToUnixSeconds(result.trade.entryTime);
            return entryTs !== null && result.entryQuoteTs !== null
                ? Math.max(0, result.entryQuoteTs - entryTs)
                : null;
        })
        .filter((value): value is number => value !== null);
    const limitEntryImprovements = results
        .map((result) => result.entryImprovement)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limitExitEnabled = limitEntryEnabled && settings?.exitEnabled === true;
    const limitExitFilledTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "filled"
        && result.exitSource === "target"
    ).length;
    const limitExitFallbackTrades = limitExitEnabled
        ? results.filter((result) =>
            result.entrySource === "limit"
            && result.entryStatus === "filled"
            && result.exitSource !== "target"
            && result.pnl !== null
        ).length
        : 0;
    return {
        evaluationMode,
        allowMultipleTradesPerEvent: allowMultipleTradesPerEvent || undefined,
        scoredTrades: scored.length,
        duplicateTradesIgnored: results.filter((result) => result.exitSource === "duplicate").length,
        entryPriceFilteredTrades: results.filter((result) => result.exitSource === "entry_price_filtered").length,
        entryTimeFilteredTrades: results.filter((result) => result.exitSource === "entry_time_filtered").length,
        missingOutcomeTrades: results.filter((result) => result.exitSource === "no_event").length,
        missingQuoteTrades: results.filter((result) =>
            result.exitSource === "missing"
            && (
                result.entrySource !== "limit"
                || result.entryStatus === "filled"
                || result.entryStatus === "missing_price_points"
                || !result.entryStatus
            )
        ).length,
        signalExitedTrades: scored.filter((result) => result.exitSource === "signal").length,
        targetExitedTrades: scored.filter((result) => result.exitSource === "target").length,
        resolvedTrades: scored.filter((result) => result.exitSource === "resolution").length,
        netPnl: scored.reduce((sum, result) => sum + (result.pnl ?? 0), 0),
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
        expectancy: scored.length > 0 ? scored.reduce((sum, result) => sum + (result.pnl ?? 0), 0) / scored.length : 0,
        avgEntryPrice: entryPrices.length > 0
            ? entryPrices.reduce((sum, value) => sum + value, 0) / entryPrices.length
            : null,
        avgExitPrice: exitPrices.length > 0
            ? exitPrices.reduce((sum, value) => sum + value, 0) / exitPrices.length
            : null,
        exactQuoteCoveragePct: scored.length > 0 ? (exactEntries / scored.length) * 100 : 0,
        limitEntryEnabled: limitEntryEnabled || undefined,
        limitEntryMode: limitEntryEnabled ? resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) : undefined,
        limitEntryPriceCents: limitEntryEnabled && resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) === "fixed_price"
            ? clampPolymarketPostSignalLimitEntryPriceCents(settings?.priceCents)
            : limitEntryEnabled
                ? results
                    .map((result) => result.entryLimitPrice)
                    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
                    .map((value) => Math.round(value * 100))[0]
                : undefined,
        limitEntryOffsetCents: limitEntryEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.offsetCents) : undefined,
        limitEntryAttempts: limitEntryEnabled ? limitEntryAttempts : undefined,
        limitEntryFilledTrades: limitEntryEnabled ? limitEntryFilledTrades : undefined,
        limitEntryMissedTrades: limitEntryEnabled ? limitEntryMissedTrades : undefined,
        limitEntryNotTouchedTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "not_touched").length
            : undefined,
        limitEntryLastMinuteOnlyTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "last_minute_only").length
            : undefined,
        limitEntryMissingPriceTrades: limitEntryEnabled ? limitEntryMissingPriceTrades : undefined,
        limitEntryInvalidWindowTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "invalid_window").length
            : undefined,
        limitEntryFillRate: limitEntryEnabled && limitEntryAttempts > 0 ? limitEntryFilledTrades / limitEntryAttempts : undefined,
        avgLimitEntryWaitSec: limitEntryEnabled && limitEntryWaits.length > 0
            ? limitEntryWaits.reduce((sum, value) => sum + value, 0) / limitEntryWaits.length
            : undefined,
        avgLimitEntryImprovement: limitEntryEnabled && limitEntryImprovements.length > 0
            ? limitEntryImprovements.reduce((sum, value) => sum + value, 0) / limitEntryImprovements.length
            : undefined,
        limitExitEnabled: limitExitEnabled || undefined,
        limitExitMode: limitExitEnabled ? resolvePolymarketPostSignalLimitExitMode(settings?.exitMode) : undefined,
        limitExitPriceCents: limitExitEnabled ? clampPolymarketPostSignalLimitExitPriceCents(settings?.exitPriceCents) : undefined,
        limitExitOffsetCents: limitExitEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.exitOffsetCents) : undefined,
        limitExitFilledTrades: limitExitEnabled ? limitExitFilledTrades : undefined,
        limitExitFallbackTrades: limitExitEnabled ? limitExitFallbackTrades : undefined,
        limitExitUnreachableTrades: limitExitEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.exitStatus === "unreachable").length
            : undefined,
    };
}

export function evaluateSecondMarketTrades(args: {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    quotes: readonly PolymarketClob1sQuoteRow[];
    evaluationMode?: PolymarketExitMode;
    allowMultipleTradesPerEvent?: boolean;
    mode?: SecondMarketAlignmentMode;
    maxQuoteAgeSec?: number;
    fillSource?: SecondMarketFillSource;
    entryPriceFilterCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
}): { results: SecondMarketTradeResult[]; summary: SecondMarketBacktestSummary } {
    const evaluationMode = args.evaluationMode ?? "resolve_hold";
    const allowMultipleTradesPerEvent = args.allowMultipleTradesPerEvent === true;
    const mode = args.mode ?? "strict";
    const maxQuoteAgeSec = Math.max(0, Math.floor(args.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC));
    const fillSource = args.fillSource ?? "bid_ask";
    const results: SecondMarketTradeResult[] = [];
    const seenEvents = new Set<string>();
    const limitEntryEnabled = args.limitEntry?.enabled === true;
    const limitEntryMode = resolvePolymarketPostSignalLimitEntryMode(args.limitEntry?.priceMode);
    const limitEntryOffsetCents = clampPolymarketPostSignalLimitOffsetCents(args.limitEntry?.offsetCents);
    const fixedLimitPrice = clampPolymarketPostSignalLimitEntryPriceCents(args.limitEntry?.priceCents) / 100;
    const limitExitEnabled = limitEntryEnabled && args.limitEntry?.exitEnabled === true;

    for (const trade of args.trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;
        const outcome = findContainingPolymarketEvent(entryTs, args.outcomes);
        const side: SecondMarketSide = trade.type === "long" ? "yes" : "no";
        if (!outcome) {
            results.push({
                trade,
                outcome: null,
                side: null,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "no_event",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        const eventKey = `${outcome.series_id}:${outcome.event_start_ts}`;
        if (!allowMultipleTradesPerEvent && seenEvents.has(eventKey)) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "duplicate" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryLimitPrice: limitEntryEnabled ? fixedLimitPrice : null,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "duplicate",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        const rawExitTs = trade.exitReason === "end_of_data"
            ? null
            : parseTimeToUnixSeconds(trade.exitTime);
        const signalExitTs = evaluationMode === "signal_exit_same_event"
            && trade.exitReason === "signal"
            && rawExitTs !== null
            && rawExitTs < outcome.event_end_ts
            ? rawExitTs
            : null;

        const entryCutoff = resolvePolymarketEntryCutoff({
            entryTimeSec: entryTs,
            eventEndTs: outcome.event_end_ts,
            enabled: args.entryCutoffEnabled,
            cutoffSeconds: args.entryCutoffSeconds,
        });
        if (!entryCutoff.allowed) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryLimitPrice: limitEntryEnabled ? fixedLimitPrice : null,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "entry_time_filtered",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        let entry: Fill | null = null;
        let entryLimitPrice: number | null = null;
        let entryImprovement: number | null = null;
        if (limitEntryEnabled && args.limitEntry) {
            const limitFill = findPostSignalLimitEntryFill(buildClobPricePoints({
                seriesId: outcome.series_id,
                eventStartTs: outcome.event_start_ts,
                yesTokenId: outcome.yes_token_id,
                noTokenId: outcome.no_token_id,
                quotes: args.quotes,
                orderSide: "buy",
                fillSource,
            }), {
                side,
                startTs: entryTs,
                eventEndTs: outcome.event_end_ts,
                limitPrice: fixedLimitPrice,
                priceMode: limitEntryMode,
                offsetPrice: limitEntryOffsetCents / 100,
                latestAllowedTs: signalExitTs,
            });
            entryLimitPrice = limitFill.limitPrice ?? fixedLimitPrice;
            if (limitFill.status !== "filled" || limitFill.fillPrice === null || limitFill.fillTs === null) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "limit",
                    entryStatus: limitFill.status,
                    entryMode: limitEntryMode,
                    entryOffsetCents: limitEntryOffsetCents,
                    entryPrice: null,
                    entryQuoteTs: null,
                    entryLimitPrice,
                    entryImprovement: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            entry = {
                price: limitFill.fillPrice,
                quoteTs: limitFill.fillTs,
            };
            entryImprovement = limitFill.entryImprovement;
        } else {
            entry = findQuoteFill({
                seriesId: outcome.series_id,
                eventStartTs: outcome.event_start_ts,
                yesTokenId: outcome.yes_token_id,
                noTokenId: outcome.no_token_id,
                fillTs: entryTs,
                side,
                orderSide: "buy",
                quotes: args.quotes,
                mode,
                maxQuoteAgeSec,
                fillSource,
            });
            if (!entry) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "quote",
                    entryPrice: null,
                    entryQuoteTs: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
        }

        if (isPolymarketEntryPriceFiltered(entry.price, args.entryPriceFilterCents)) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: entry.price,
                entryQuoteTs: entry.quoteTs,
                entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "entry_price_filtered",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }
        let exitTargetPrice: number | null = null;
        const targetExit = limitExitEnabled && args.limitEntry
            ? (() => {
                exitTargetPrice = resolvePolymarketLimitExitTargetPrice(entry.price, args.limitEntry);
                return findPostSignalLimitExitFill(buildClobPricePoints({
                    seriesId: outcome.series_id,
                    eventStartTs: outcome.event_start_ts,
                    yesTokenId: outcome.yes_token_id,
                    noTokenId: outcome.no_token_id,
                    quotes: args.quotes,
                    orderSide: "sell",
                    fillSource,
                }), {
                    side,
                    startTs: entry.quoteTs,
                    eventEndTs: outcome.event_end_ts,
                    targetPrice: exitTargetPrice,
                });
            })()
            : null;

        const exit = (() => {
            if (signalExitTs !== null) {
                const targetFillsFirst = targetExit?.status === "filled"
                    && targetExit.fillTs !== null
                    && targetExit.fillPrice !== null
                    && targetExit.fillTs <= signalExitTs;
                if (targetFillsFirst) {
                    return {
                        price: targetExit.fillPrice,
                        quoteTs: targetExit.fillTs,
                        source: "target" as const,
                        targetPrice: exitTargetPrice,
                        status: targetExit.status,
                    };
                }

                const fill = findQuoteFill({
                    seriesId: outcome.series_id,
                    eventStartTs: outcome.event_start_ts,
                    yesTokenId: outcome.yes_token_id,
                    noTokenId: outcome.no_token_id,
                    fillTs: signalExitTs,
                    side,
                    orderSide: "sell",
                    quotes: args.quotes,
                    mode,
                    maxQuoteAgeSec,
                    fillSource,
                });
                return fill && fill.quoteTs >= entry.quoteTs
                    ? {
                        price: fill.quoteTs === entry.quoteTs ? entry.price : fill.price,
                        quoteTs: fill.quoteTs,
                        source: "signal" as const,
                        targetPrice: exitTargetPrice,
                        status: targetExit?.status,
                    }
                    : null;
            }

            if (targetExit?.status === "filled" && targetExit.fillPrice !== null) {
                return {
                    price: targetExit.fillPrice,
                    quoteTs: targetExit.fillTs,
                    source: "target" as const,
                    targetPrice: exitTargetPrice,
                    status: targetExit.status,
                };
            }

            const price = resolveResolutionExitPrice(outcome, side);
            return price === null
                ? null
                : {
                    price,
                    quoteTs: null,
                    source: "resolution" as const,
                    targetPrice: exitTargetPrice,
                    status: targetExit?.status,
                };
        })();

        if (!exit || exit.price === null) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: entry.price,
                entryQuoteTs: entry.quoteTs,
                entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "missing",
                exitTargetPrice,
                exitStatus: targetExit?.status,
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        if (!allowMultipleTradesPerEvent) {
            seenEvents.add(eventKey);
        }
        const pnl = exit.price - entry.price;
        results.push({
            trade,
            outcome,
            side,
            entrySource: limitEntryEnabled ? "limit" : "quote",
            entryStatus: limitEntryEnabled ? "filled" : undefined,
            entryMode: limitEntryEnabled ? limitEntryMode : undefined,
            entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
            entryPrice: entry.price,
            entryQuoteTs: entry.quoteTs,
            entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
            entryImprovement: limitEntryEnabled ? entryImprovement : null,
            exitPrice: exit.price,
            exitQuoteTs: exit.quoteTs,
            exitSource: exit.source,
            exitTargetPrice: exit.targetPrice,
            exitStatus: exit.status,
            pnl,
            isProfitable: pnl > 0 ? true : pnl < 0 ? false : null,
        });
    }

    return { results, summary: buildSummary(results, evaluationMode, args.limitEntry, allowMultipleTradesPerEvent) };
}
