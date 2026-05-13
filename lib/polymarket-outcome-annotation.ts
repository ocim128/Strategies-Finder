import type { Trade } from "./types/strategies";
import type {
    PolymarketOutcomeRow,
    TradePolymarketOutcome,
} from "./types/polymarket-outcomes";

export function getPolymarketPredictionForTrade(trade: Pick<Trade, "type">): TradePolymarketOutcome["prediction"] {
    return trade.type === "long" ? "yes" : "no";
}

export function isPolymarketPredictionWin(
    prediction: TradePolymarketOutcome["prediction"],
    outcome: Pick<PolymarketOutcomeRow, "resolved_outcome_up">
): boolean {
    return prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
}

export function buildPolymarketOutcomeBase(args: {
    outcome: PolymarketOutcomeRow;
    prediction: TradePolymarketOutcome["prediction"];
    isWin: boolean | null;
}): TradePolymarketOutcome {
    const { outcome, prediction, isWin } = args;
    return {
        eventStartTs: outcome.event_start_ts,
        eventEndTs: outcome.event_end_ts,
        eventSlug: outcome.event_slug,
        marketSlug: outcome.market_slug || outcome.event_slug,
        prediction,
        actualOutcomeUp: outcome.resolved_outcome_up,
        isWin,
    };
}
