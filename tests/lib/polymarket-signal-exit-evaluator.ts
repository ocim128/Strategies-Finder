import { parseTimeToUnixSeconds } from "./time-normalization";
import { findContainingEvent } from "./polymarket-1m-5m-bridge";
import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";
import { findEntryFill, findSignalExitFill, indexPricePointsByEvent } from "./polymarket-price-points";
import type { Trade } from "./types/strategies";
import type {
    PolymarketOutcomeRow,
    TradePolymarketOutcome,
} from "./types/polymarket-outcomes";

export interface SignalExitEvalInput {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    pricePoints: readonly PolymarketPricePoint[];
}

export interface SignalExitTradeResult {
    trade: Trade;
    outcome: PolymarketOutcomeRow;
    side: "yes" | "no";
    entryPrice: number | null;
    exitPrice: number | null;
    exitTs: number | null;
    exitSource: "signal" | "resolution" | "missing";
    pnl: number | null;
    isProfitable: boolean | null;
    actualOutcomeUp: 0 | 1;
    isWin: boolean;
}

export interface SignalExitSummary {
    scoredTrades: number;
    missingPriceTrades: number;
    profitableTrades: number;
    losingTrades: number;
    signalExitedTrades: number;
    resolvedTrades: number;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    expectancy: number;
    avgEntryPrice: number;
    avgExitPrice: number;
    totalPnl: number;
}

export function evaluateSignalExitTrades(
    input: SignalExitEvalInput
): { results: SignalExitTradeResult[]; summary: SignalExitSummary } {
    const { trades, outcomes, pricePoints } = input;
    const priceIndex = indexPricePointsByEvent(pricePoints);
    const results: SignalExitTradeResult[] = [];

    const seenEvents = new Set<number>();

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const outcome = findContainingEvent(entryTs, outcomes);
        if (!outcome) continue;

        if (seenEvents.has(outcome.event_start_ts)) continue;
        seenEvents.add(outcome.event_start_ts);

        const side: "yes" | "no" = trade.type === "long" ? "yes" : "no";
        const isWin = side === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;

        const eventPoints = priceIndex.pointsByEventStart.get(outcome.event_start_ts) ?? [];

        const entryFill = findEntryFill(eventPoints, entryTs, side);
        if (!entryFill) {
            results.push({
                trade,
                outcome,
                side,
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

        let exitPrice: number | null = null;
        let exitTs: number | null = null;
        let exitSource: "signal" | "resolution" | "missing" = "resolution";
        let signalExitAttempted = false;

        if (trade.exitReason === "signal") {
            const exitTsRaw = parseTimeToUnixSeconds(trade.exitTime);
            if (exitTsRaw !== null && exitTsRaw < outcome.event_end_ts) {
                signalExitAttempted = true;
                const exitFill = findSignalExitFill(eventPoints, exitTsRaw, side);
                if (exitFill && exitFill.ts > entryFill.ts) {
                    exitPrice = exitFill.price;
                    exitTs = exitFill.ts;
                    exitSource = "signal";
                } else {
                    exitSource = "missing";
                }
            }
        }

        if (exitSource === "missing" && signalExitAttempted) {
            results.push({
                trade,
                outcome,
                side,
                entryPrice: entryFill.price,
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

        if (exitSource !== "signal") {
            if (outcome.resolved_outcome_up === 1) {
                exitPrice = side === "yes" ? 1 : 0;
            } else {
                exitPrice = side === "yes" ? 0 : 1;
            }
            exitTs = outcome.event_end_ts;
            exitSource = "resolution";
        }

        const pnl = exitPrice !== null ? exitPrice - entryFill.price : null;
        const isProfitable = pnl !== null ? pnl > 0 : null;

        results.push({
            trade,
            outcome,
            side,
            entryPrice: entryFill.price,
            exitPrice,
            exitTs,
            exitSource,
            pnl,
            isProfitable,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
        });
    }

    const summary = buildSignalExitSummary(results);
    return { results, summary };
}

function buildSignalExitSummary(results: readonly SignalExitTradeResult[]): SignalExitSummary {
    let scoredTrades = 0;
    let missingPriceTrades = 0;
    let profitableTrades = 0;
    let losingTrades = 0;
    let signalExitedTrades = 0;
    let resolvedTrades = 0;
    let netPnl = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalEntryPrice = 0;
    let totalExitPrice = 0;
    let pricedCount = 0;

    for (const r of results) {
        if (r.exitSource === "missing") {
            missingPriceTrades++;
            continue;
        }

        scoredTrades++;

        if (r.exitSource === "signal") signalExitedTrades++;
        else resolvedTrades++;

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
                profitableTrades++;
            }
        }
    }

    return {
        scoredTrades,
        missingPriceTrades,
        profitableTrades,
        losingTrades,
        signalExitedTrades,
        resolvedTrades,
        netPnl,
        grossProfit,
        grossLoss,
        profitFactor: grossProfit > 0 ? (grossLoss > 0 ? grossProfit / grossLoss : Infinity) : 0,
        expectancy: pricedCount > 0 ? netPnl / pricedCount : 0,
        avgEntryPrice: pricedCount > 0 ? totalEntryPrice / pricedCount : 0,
        avgExitPrice: pricedCount > 0 ? totalExitPrice / pricedCount : 0,
        totalPnl: netPnl,
    };
}

export function buildTradeAnnotationFromSignalExitResult(
    result: SignalExitTradeResult
): TradePolymarketOutcome {
    return {
        eventStartTs: result.outcome.event_start_ts,
        eventEndTs: result.outcome.event_end_ts,
        eventSlug: result.outcome.event_slug,
        marketSlug: result.outcome.market_slug || result.outcome.event_slug,
        prediction: result.side,
        actualOutcomeUp: result.outcome.resolved_outcome_up,
        isWin: result.isWin,
        evaluationMode: "signal_exit_same_event",
        isProfitable: result.isProfitable,
        marketEntryPrice: result.entryPrice,
        marketExitPrice: result.exitPrice,
        marketExitTs: result.exitTs,
        marketExitSource: result.exitSource === "missing" ? undefined : result.exitSource,
        marketPnl: result.pnl,
    };
}
