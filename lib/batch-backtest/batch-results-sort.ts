import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

export const BATCH_RESULT_SORT_KEYS = [
    "netProfit",
    "expectancy",
    "profitFactor",
    "sharpeRatio",
    "maxDrawdownPercent",
    "totalTrades",
    "winRate",
    "avgTrade",
    "exposurePercent",
    "barCount",
    "avgHoldBars",
    "maxHoldBars",
    "avgHoldDays",
    "maxHoldDays",
] as const;

export type BatchResultSortKey = typeof BATCH_RESULT_SORT_KEYS[number];
export type BatchResultSortDirection = "asc" | "desc";

export interface BatchResultSortState {
    key: BatchResultSortKey;
    direction: BatchResultSortDirection;
}

export function isBatchResultSortKey(value: string): value is BatchResultSortKey {
    return (BATCH_RESULT_SORT_KEYS as readonly string[]).includes(value);
}

export function getBatchResultSortValue(
    row: BatchBacktestSymbolResult,
    key: BatchResultSortKey,
): number | null {
    switch (key) {
        case "netProfit": return finiteOrNull(row.result?.netProfit);
        case "expectancy": return finiteOrNull(row.result?.expectancy);
        case "profitFactor": return finiteOrNull(row.result?.profitFactor);
        case "sharpeRatio": return finiteOrNull(row.result?.sharpeRatio);
        case "maxDrawdownPercent": return finiteOrNull(row.result?.maxDrawdownPercent);
        case "totalTrades": return finiteOrNull(row.result?.totalTrades);
        case "winRate": return finiteOrNull(row.result?.winRate);
        case "avgTrade": return finiteOrNull(row.result?.avgTrade);
        case "exposurePercent": return finiteOrNull(row.tradeSummary?.exposurePercent);
        case "barCount": return finiteOrNull(row.barCount);
        case "avgHoldBars": return finiteOrNull(row.tradeSummary?.avgHoldBars);
        case "maxHoldBars": return finiteOrNull(row.tradeSummary?.maxHoldBars);
        case "avgHoldDays": return finiteOrNull(row.tradeSummary?.avgHoldDays);
        case "maxHoldDays": return finiteOrNull(row.tradeSummary?.maxHoldDays);
    }
}

export function sortBatchResults(
    rows: readonly BatchBacktestSymbolResult[],
    state: BatchResultSortState,
): BatchBacktestSymbolResult[] {
    return rows
        .map((row, index) => ({ row, index, value: getBatchResultSortValue(row, state.key) }))
        .sort((a, b) => {
            if (a.value === null && b.value === null) return a.index - b.index;
            if (a.value === null) return 1;
            if (b.value === null) return -1;
            const difference = (a.value - b.value) * (state.direction === "asc" ? 1 : -1);
            return difference || a.index - b.index;
        })
        .map(({ row }) => row);
}

function finiteOrNull(value: number | null | undefined): number | null {
    return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}
