import { parseTimeToUnixSeconds } from "./time-normalization";
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

type WindowDef = typeof WINDOW_DEFS[number];

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

function isPolymarketPredictionWin(trade: Trade, row: PolymarketOutcomeRow): boolean {
    return trade.type === "long"
        ? row.resolved_outcome_up === 1
        : row.resolved_outcome_up === 0;
}

function buildWindowStat(
    def: WindowDef,
    targetPrice: number,
    eligibleTrades: Array<{ trade: Trade; row: PolymarketOutcomeRow }>
): PolymarketFillWindowStat {
    let filledTrades = 0;
    let filledWins = 0;
    let missingPriceTrades = 0;

    for (const item of eligibleTrades) {
        const prices = getTradeCheckpointPrices(item.trade, item.row).slice(0, def.maxIndex + 1);
        const seenPrices = prices.filter((price): price is number => price !== null);
        if (seenPrices.length === 0) {
            missingPriceTrades++;
            continue;
        }

        const filled = seenPrices.some((price) => price <= targetPrice);
        if (!filled) {
            continue;
        }

        filledTrades++;
        if (isPolymarketPredictionWin(item.trade, item.row)) {
            filledWins++;
        }
    }

    const filledLosses = Math.max(0, filledTrades - filledWins);
    const eligibleCount = eligibleTrades.length;

    return {
        key: def.key,
        label: def.label,
        filledTrades,
        fillRate: eligibleCount > 0 ? filledTrades / eligibleCount : 0,
        filledWins,
        filledLosses,
        filledWinRate: filledTrades > 0 ? filledWins / filledTrades : 0,
        missingPriceTrades,
    };
}

export function analyzePolymarketFillability(args: {
    trades: Trade[];
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>;
    targetPriceCents: number;
    scope?: PolymarketFillScope;
}): PolymarketFillAnalysis {
    const scope = args.scope ?? "all";
    const targetPriceCents = clamp01(Number(args.targetPriceCents) / 100) * 100;
    const targetPrice = targetPriceCents / 100;
    const filteredTrades = args.trades.filter((trade) => shouldIncludeTrade(trade, scope));

    const eligibleTrades: Array<{ trade: Trade; row: PolymarketOutcomeRow }> = [];
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

        eligibleTrades.push({ trade, row });
    }

    return {
        targetPrice,
        targetPriceCents,
        scope,
        selectedTrades: filteredTrades.length,
        eligibleTrades: eligibleTrades.length,
        missingOutcomeTrades,
        windows: WINDOW_DEFS.map((def) => buildWindowStat(def, targetPrice, eligibleTrades)),
    };
}
