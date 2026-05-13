import { parseTimeToUnixSeconds } from "../time-normalization";
import type { Trade } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
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

function resolveResolutionExitPrice(outcome: PolymarketOutcomeRow, side: SecondMarketSide): number {
    if (outcome.resolved_outcome_up === 1) {
        return side === "yes" ? 1 : 0;
    }
    return side === "yes" ? 0 : 1;
}

function buildSummary(results: readonly SecondMarketTradeResult[]): SecondMarketBacktestSummary {
    const scored = results.filter((result) => result.pnl !== null);
    const grossProfit = scored.reduce((sum, result) => sum + Math.max(0, result.pnl ?? 0), 0);
    const grossLoss = Math.abs(scored.reduce((sum, result) => sum + Math.min(0, result.pnl ?? 0), 0));
    const entryPrices = scored.map((result) => result.entryPrice).filter((value): value is number => value !== null);
    const exitPrices = scored.map((result) => result.exitPrice).filter((value): value is number => value !== null);
    const exactEntries = scored.filter((result) => {
        const entryTs = parseTimeToUnixSeconds(result.trade.entryTime);
        return entryTs !== null && result.entryQuoteTs === entryTs;
    }).length;
    return {
        evaluationMode: "second_clob",
        scoredTrades: scored.length,
        duplicateTradesIgnored: results.filter((result) => result.exitSource === "duplicate").length,
        missingOutcomeTrades: results.filter((result) => result.exitSource === "no_event").length,
        missingQuoteTrades: results.filter((result) => result.exitSource === "missing").length,
        signalExitedTrades: scored.filter((result) => result.exitSource === "signal").length,
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
    };
}

export function evaluateSecondMarketTrades(args: {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    quotes: readonly PolymarketClob1sQuoteRow[];
    mode?: SecondMarketAlignmentMode;
    maxQuoteAgeSec?: number;
    fillSource?: SecondMarketFillSource;
}): { results: SecondMarketTradeResult[]; summary: SecondMarketBacktestSummary } {
    const mode = args.mode ?? "strict";
    const maxQuoteAgeSec = Math.max(0, Math.floor(args.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC));
    const fillSource = args.fillSource ?? "bid_ask";
    const results: SecondMarketTradeResult[] = [];
    const seenEvents = new Set<string>();

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
        if (seenEvents.has(eventKey)) {
            results.push({
                trade,
                outcome,
                side,
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

        const entry = findQuoteFill({
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

        const rawExitTs = trade.exitReason === "signal"
            ? parseTimeToUnixSeconds(trade.exitTime)
            : null;
        const signalExitTs = rawExitTs !== null && rawExitTs < outcome.event_end_ts
            ? rawExitTs
            : null;
        const exit = signalExitTs === null
            ? {
                price: resolveResolutionExitPrice(outcome, side),
                quoteTs: null,
                source: "resolution" as const,
            }
            : (() => {
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
                return fill
                    ? { price: fill.price, quoteTs: fill.quoteTs, source: "signal" as const }
                    : null;
            })();

        if (!exit) {
            results.push({
                trade,
                outcome,
                side,
                entryPrice: entry.price,
                entryQuoteTs: entry.quoteTs,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "missing",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        seenEvents.add(eventKey);
        const pnl = exit.price - entry.price;
        results.push({
            trade,
            outcome,
            side,
            entryPrice: entry.price,
            entryQuoteTs: entry.quoteTs,
            exitPrice: exit.price,
            exitQuoteTs: exit.quoteTs,
            exitSource: exit.source,
            pnl,
            isProfitable: pnl > 0 ? true : pnl < 0 ? false : null,
        });
    }

    return { results, summary: buildSummary(results) };
}
