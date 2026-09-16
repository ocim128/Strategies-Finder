import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(Number(params.min_streak ?? 2))),
    };
}

export const sweep_reclaim_defended_floor_collapse: Strategy = {
    name: "Sweep Reclaim Defended Floor Collapse",
    description: "Trades liquidation cascades when price breaks through a multi-bar defended sweep support or resistance cluster.",
    defaultParams: {
        min_streak: 2,
    },
    paramLabels: {
        min_streak: "Min Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const min_streak = p.min_streak as number;
        if (cleanData.length < min_streak + 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const bullFlags = sweep.map((v) => (v !== null && v >= 0.15 ? 1 : 0));
        const bearFlags = sweep.map((v) => (v !== null && v <= -0.15 ? 1 : 0));
        const bullSweepStreak = buildStreakCount(bullFlags);
        const bearSweepStreak = buildStreakCount(bearFlags);

        return createSignalLoop(cleanData, [sweep], (i) => {
            if (i < 1) return null;

            if (bearSweepStreak[i - 1] >= min_streak && cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish defended ceiling collapse: prior bear sweep streak ${bearSweepStreak[i - 1]} >= ${min_streak}, close > prior high`);
            }
            if (bullSweepStreak[i - 1] >= min_streak && cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish defended floor collapse: prior bull sweep streak ${bullSweepStreak[i - 1]} >= ${min_streak}, close < prior low`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_streak"],
    },
};
