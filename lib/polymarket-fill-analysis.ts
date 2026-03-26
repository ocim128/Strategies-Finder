import { parseTimeToUnixSeconds } from "./time-normalization";
import type { PolymarketFillHistorySummary } from "./polymarket-fill-history";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";
import type { Trade } from "./types/strategies";

export type PolymarketFillScope = "all" | "long" | "short";

export interface PolymarketFillWindowStat {
    key: "open" | "minute_1" | "minute_2" | "minute_3" | "minute_4";
    label: string;
    filledTrades: number;
    fillRate: number;
    filledWins: number;
    filledLosses: number;
    filledWinRate: number;
    missingPriceTrades: number;
}

export interface PolymarketFillAnalysis {
    targetPrice: number;
    targetPriceCents: number;
    scope: PolymarketFillScope;
    selectedTrades: number;
    eligibleTrades: number;
    enrichedEligibleTrades: number;
    fallbackEligibleTrades: number;
    missingOutcomeTrades: number;
    windows: PolymarketFillWindowStat[];
}

const WINDOW_DEFS = [
    { key: "open", label: "Open", maxIndex: 0 },
    { key: "minute_1", label: "By +1m", maxIndex: 1 },
    { key: "minute_2", label: "By +2m", maxIndex: 2 },
    { key: "minute_3", label: "By +3m", maxIndex: 3 },
    { key: "minute_4", label: "By +4m", maxIndex: 4 },
] as const;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function shouldIncludeTrade(trade: Trade, scope: PolymarketFillScope): boolean {
    if (scope === "all") return true;
    return scope === trade.type;
}

function getYesCheckpointPrices(row: PolymarketOutcomeRow): Array<number | null> {
    return [
        row.yes_open_price,
        row.yes_entry_minute_1_price,
        row.yes_entry_minute_2_price,
        row.yes_entry_minute_3_price,
        row.yes_entry_minute_4_price,
    ];
}

function getTradeCheckpointPrices(trade: Trade, row: PolymarketOutcomeRow): Array<number | null> {
    const yesPrices = getYesCheckpointPrices(row);
    if (trade.type === "long") {
        return yesPrices;
    }
    return yesPrices.map((price) => price === null ? null : clamp01(1 - price));
}

function hasUsableHistorySummary(
    historySummary: PolymarketFillHistorySummary | undefined
): historySummary is PolymarketFillHistorySummary {
    return Boolean(historySummary && historySummary.windows.some((window) => window.sampleCount > 0));
}

function getTradeWindowReferencePrices(
    trade: Trade,
    row: PolymarketOutcomeRow,
    historySummary: PolymarketFillHistorySummary | undefined
): Array<number | null> {
    if (!hasUsableHistorySummary(historySummary)) {
        return getTradeCheckpointPrices(trade, row);
    }

    if (trade.type === "long") {
        return historySummary.windows.map((window) => window.yesMinPrice);
    }

    return historySummary.windows.map((window) => (
        window.yesMaxPrice === null ? null : clamp01(1 - window.yesMaxPrice)
    ));
}

function isPolymarketPredictionWin(trade: Trade, row: PolymarketOutcomeRow): boolean {
    return trade.type === "long"
        ? row.resolved_outcome_up === 1
        : row.resolved_outcome_up === 0;
}

export function analyzePolymarketFillability(args: {
    trades: Trade[];
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>;
    historySummaryByStartTs?: Map<number, PolymarketFillHistorySummary>;
    targetPriceCents: number;
    scope?: PolymarketFillScope;
}): PolymarketFillAnalysis {
    const scope = args.scope ?? "all";
    const targetPriceCents = clamp01(Number(args.targetPriceCents) / 100) * 100;
    const targetPrice = targetPriceCents / 100;
    const filteredTrades = args.trades.filter((trade) => shouldIncludeTrade(trade, scope));

    const eligibleTrades: Array<{ trade: Trade; row: PolymarketOutcomeRow; historySummary?: PolymarketFillHistorySummary }> = [];
    let missingOutcomeTrades = 0;

    for (const trade of filteredTrades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            missingOutcomeTrades++;
            continue;
        }

        const row = args.outcomeByStartTs.get(entryTs);
        if (!row) {
            missingOutcomeTrades++;
            continue;
        }

        eligibleTrades.push({
            trade,
            row,
            historySummary: args.historySummaryByStartTs?.get(entryTs),
        });
    }

    return {
        targetPrice,
        targetPriceCents,
        scope,
        selectedTrades: filteredTrades.length,
        eligibleTrades: eligibleTrades.length,
        enrichedEligibleTrades: eligibleTrades.filter((item) => hasUsableHistorySummary(item.historySummary)).length,
        fallbackEligibleTrades: eligibleTrades.filter((item) => !hasUsableHistorySummary(item.historySummary)).length,
        missingOutcomeTrades,
        windows: WINDOW_DEFS.map((def) => {
            let filledTrades = 0;
            let filledWins = 0;
            let missingPriceTrades = 0;

            for (const item of eligibleTrades) {
                const prices = getTradeWindowReferencePrices(item.trade, item.row, item.historySummary)
                    .slice(0, def.maxIndex + 1);
                const seenPrices = prices.filter((price): price is number => price !== null);
                if (seenPrices.length === 0) {
                    missingPriceTrades++;
                    continue;
                }

                if (!seenPrices.some((price) => price <= targetPrice)) {
                    continue;
                }

                filledTrades++;
                if (isPolymarketPredictionWin(item.trade, item.row)) {
                    filledWins++;
                }
            }

            const filledLosses = Math.max(0, filledTrades - filledWins);
            return {
                key: def.key,
                label: def.label,
                filledTrades,
                fillRate: eligibleTrades.length > 0 ? filledTrades / eligibleTrades.length : 0,
                filledWins,
                filledLosses,
                filledWinRate: filledTrades > 0 ? filledWins / filledTrades : 0,
                missingPriceTrades,
            };
        }),
    };
}
