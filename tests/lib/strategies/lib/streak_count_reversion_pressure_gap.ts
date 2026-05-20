import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 5))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.02)),
    };
}

export const streak_count_reversion_pressure_gap: Strategy = {
    name: "Streak Count Reversion Pressure Gap",
    description: "Fades highly extended directional streaks on Binance, executing the counter-trend trade only when a favorable Polymarket pressure gap mismatch confirms the market has overreacted to the streak.",
    defaultParams: {
        streakThreshold: 5,
        minEdge: 0.02,
    },
    paramLabels: {
        streakThreshold: "Streak Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const streakThreshold = p.streakThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < streakThreshold + 1) return [];

        const len = cleanData.length;
        const returnSigns = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
            const prev = cleanData[i - 1].close;
            const diff = cleanData[i].close - prev;
            returnSigns[i] = diff > 0 ? 1 : diff < 0 ? -1 : 0;
        }

        const streaks = buildStreakCount(returnSigns);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: 20 });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [pressure.longEdge, pressure.shortEdge], (i) => {
            const streak = streaks[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];

            if (longEdge === null || shortEdge === null) return null;

            // Buy: consecutive down-close streak (streak is negative, <= -streakThreshold), longEdge >= minEdge
            if (streak <= -streakThreshold && longEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Down-close streak reached ${streak} with long edge ${longEdge.toFixed(3)}`);
            }

            // Sell: consecutive up-close streak (streak is positive, >= streakThreshold), shortEdge >= minEdge
            if (streak >= streakThreshold && shortEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Up-close streak reached ${streak} with short edge ${shortEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakThreshold", "minEdge"],
    },
};
