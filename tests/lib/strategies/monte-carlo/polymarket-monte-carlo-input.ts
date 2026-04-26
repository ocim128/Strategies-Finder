import type { BacktestResult, Trade } from "../../types/strategies";
import type { TradePolymarketOutcome } from "../../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../../polymarket-exit-mode";
import type { MonteCarloCoverageSummary, PolymarketMonteCarloInput, PolymarketMonteCarloTradeInput } from "./types";

function hasTradeLevelPolymarketAnnotations(trades: readonly Trade[]): boolean {
    return trades.some((trade) => "polymarketOutcome" in trade);
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolvePolymarketMonteCarloEvaluationMode(
    result: Pick<BacktestResult, "trades" | "polymarketTradeSummary">
): PolymarketExitMode {
    if (result.polymarketTradeSummary?.evaluationMode) {
        return result.polymarketTradeSummary.evaluationMode;
    }

    for (const trade of result.trades) {
        if (trade.polymarketOutcome?.evaluationMode) {
            return trade.polymarketOutcome.evaluationMode;
        }
    }

    return "resolve_hold";
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

function buildCoverageSummary(args: {
    usableTrades: number;
    totalTrades: number;
    missingPriceTrades: number;
    missingOutcomeTrades: number;
    duplicateTradesIgnored: number;
    filteredTradesIgnored: number;
}): MonteCarloCoverageSummary {
    const {
        usableTrades,
        totalTrades,
        missingPriceTrades,
        missingOutcomeTrades,
        duplicateTradesIgnored,
        filteredTradesIgnored,
    } = args;
    const scorableUniverse = usableTrades + missingPriceTrades + missingOutcomeTrades;

    return {
        usableTrades,
        totalTrades,
        overallCoverage: totalTrades > 0 ? usableTrades / totalTrades : 0,
        dataCoverage: scorableUniverse > 0 ? usableTrades / scorableUniverse : 0,
        missingPriceTrades,
        missingOutcomeTrades,
        duplicateTradesIgnored,
        filteredTradesIgnored,
    };
}

export function buildPolymarketMonteCarloInput(backtestResult: BacktestResult): PolymarketMonteCarloInput {
    const trades = backtestResult.trades;
    const usableTrades: PolymarketMonteCarloTradeInput[] = [];
    let countedMissingPriceTrades = 0;
    let countedMissingOutcomeTrades = 0;
    let countedDuplicateTradesIgnored = 0;
    let countedFilteredTradesIgnored = 0;

    for (const trade of trades) {
        const outcome = trade.polymarketOutcome;
        if (!outcome) {
            countedMissingOutcomeTrades++;
            continue;
        }

        switch (outcome.marketExitSource) {
            case "duplicate":
                countedDuplicateTradesIgnored++;
                continue;
            case "filtered":
                countedFilteredTradesIgnored++;
                continue;
            case "missing":
                countedMissingPriceTrades++;
                continue;
            case "no_event":
                countedMissingOutcomeTrades++;
                continue;
            default:
                break;
        }

        if (!isFinitePositiveNumber(outcome.marketEntryPrice)) {
            countedMissingPriceTrades++;
            continue;
        }

        const sharePnl = derivePolymarketSharePnl(outcome);
        if (sharePnl === null || !Number.isFinite(sharePnl)) {
            countedMissingPriceTrades++;
            continue;
        }

        usableTrades.push({
            entryPrice: outcome.marketEntryPrice,
            sharePnl,
            exitTime: trade.exitTime,
        });
    }

    const summary = backtestResult.polymarketTradeSummary;
    const missingPriceTrades = summary?.missingPriceTrades ?? countedMissingPriceTrades;
    const missingOutcomeTrades = summary?.missingOutcomeTrades ?? countedMissingOutcomeTrades;
    const duplicateTradesIgnored = summary?.duplicateTradesIgnored ?? countedDuplicateTradesIgnored;
    const filteredTradesIgnored = countedFilteredTradesIgnored;

    return {
        trades: usableTrades,
        hasTradeLevelAnnotations: hasTradeLevelPolymarketAnnotations(trades),
        coverageSummary: buildCoverageSummary({
            usableTrades: usableTrades.length,
            totalTrades: trades.length,
            missingPriceTrades,
            missingOutcomeTrades,
            duplicateTradesIgnored,
            filteredTradesIgnored,
        }),
        evaluationMode: resolvePolymarketMonteCarloEvaluationMode(backtestResult),
    };
}
