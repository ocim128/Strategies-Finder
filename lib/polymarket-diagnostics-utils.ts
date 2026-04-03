import type { BacktestResult, Trade } from "./types/strategies";
import type { PolymarketFeatureAnalysis } from "./types/polymarket-outcomes";

export function clampPolymarketEntryOffset(value: number): number {
    return Math.max(0, Math.min(4, Math.floor(value)));
}

export function inferPolymarketEntryOffsetFromTrades(trades: readonly Trade[]): number | null {
    const offsets = new Set<number>();
    for (const trade of trades) {
        const entryOffset = trade.polymarketOutcome?.entryOffset;
        if (typeof entryOffset !== "number" || !Number.isFinite(entryOffset)) {
            return null;
        }
        offsets.add(clampPolymarketEntryOffset(entryOffset));
        if (offsets.size > 1) {
            return null;
        }
    }

    return offsets.size === 1 ? [...offsets][0]! : null;
}

export function resolvePolymarketSelectedEntryOffset(
    result: BacktestResult,
    fallbackOffset?: number | null
): number {
    const summaryOffset = result.polymarketTradeSummary?.entryOffset;
    if (typeof summaryOffset === "number" && Number.isFinite(summaryOffset)) {
        return clampPolymarketEntryOffset(summaryOffset);
    }

    const inferredOffset = inferPolymarketEntryOffsetFromTrades(result.trades);
    if (inferredOffset !== null) {
        return inferredOffset;
    }

    if (typeof fallbackOffset === "number" && Number.isFinite(fallbackOffset)) {
        return clampPolymarketEntryOffset(fallbackOffset);
    }

    return 0;
}

export function rankPolymarketFeatureSuggestions(
    featureAnalyses: readonly PolymarketFeatureAnalysis[]
): PolymarketFeatureAnalysis[] {
    return featureAnalyses
        .filter((analysis) => analysis.suggestedFilter !== null)
        .slice()
        .sort((left, right) => {
            if (right.expectancyIfFiltered !== left.expectancyIfFiltered) {
                return right.expectancyIfFiltered - left.expectancyIfFiltered;
            }
            if (right.winRateIfFiltered !== left.winRateIfFiltered) {
                return right.winRateIfFiltered - left.winRateIfFiltered;
            }
            if (left.tradesRemovedPercent !== right.tradesRemovedPercent) {
                return left.tradesRemovedPercent - right.tradesRemovedPercent;
            }
            if (right.separationScore !== left.separationScore) {
                return right.separationScore - left.separationScore;
            }
            return left.label.localeCompare(right.label);
        });
}
