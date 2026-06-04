import type { Trade } from "./types/strategies";
import type { TradePolymarketOutcome } from "./types/polymarket-outcomes";

export type PolymarketPayoutSkipReason =
    | "missing_outcome"
    | "duplicate"
    | "open_position"
    | "filtered"
    | "entry_price_filtered"
    | "entry_time_filtered"
    | "no_event"
    | "missing_price"
    | "missing_payout";

export interface PolymarketTradePayout {
    entryPrice: number;
    sharePnl: number;
}

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function derivePolymarketSharePnl(outcome: TradePolymarketOutcome | null | undefined): number | null {
    if (!outcome) {
        return null;
    }

    if (typeof outcome.marketPnl === "number" && Number.isFinite(outcome.marketPnl)) {
        return outcome.marketPnl;
    }

    if (
        typeof outcome.marketEntryPrice === "number"
        && Number.isFinite(outcome.marketEntryPrice)
        && typeof outcome.marketExitPrice === "number"
        && Number.isFinite(outcome.marketExitPrice)
    ) {
        return outcome.marketExitPrice - outcome.marketEntryPrice;
    }

    if (
        typeof outcome.marketEntryPrice === "number"
        && Number.isFinite(outcome.marketEntryPrice)
        && typeof outcome.isWin === "boolean"
    ) {
        return outcome.isWin ? (1 - outcome.marketEntryPrice) : -outcome.marketEntryPrice;
    }

    return null;
}

export function resolvePolymarketTradePayout(
    trade: Pick<Trade, "polymarketOutcome">
): { payout: PolymarketTradePayout; skipReason: null } | { payout: null; skipReason: PolymarketPayoutSkipReason } {
    const outcome = trade.polymarketOutcome;
    if (!outcome) {
        return { payout: null, skipReason: "missing_outcome" };
    }

    switch (outcome.marketExitSource) {
        case "duplicate":
            return { payout: null, skipReason: "duplicate" };
        case "open_position":
            return { payout: null, skipReason: "open_position" };
        case "filtered":
            return { payout: null, skipReason: "filtered" };
        case "entry_price_filtered":
            return { payout: null, skipReason: "entry_price_filtered" };
        case "entry_time_filtered":
            return { payout: null, skipReason: "entry_time_filtered" };
        case "no_event":
            return { payout: null, skipReason: "no_event" };
        case "missing":
            return { payout: null, skipReason: "missing_price" };
        default:
            break;
    }

    if (!isFinitePositiveNumber(outcome.marketEntryPrice)) {
        return { payout: null, skipReason: "missing_price" };
    }

    const sharePnl = derivePolymarketSharePnl(outcome);
    if (sharePnl === null || !Number.isFinite(sharePnl)) {
        return { payout: null, skipReason: "missing_payout" };
    }

    return {
        payout: {
            entryPrice: outcome.marketEntryPrice,
            sharePnl,
        },
        skipReason: null,
    };
}
