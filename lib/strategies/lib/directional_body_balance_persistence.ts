import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, extractBarMetricSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        balanceMin: Math.max(0.5, Math.min(0.99, Number(params.balanceMin ?? 0.65))),
    };
}

export const directional_body_balance_persistence: Strategy = {
    name: "Directional Body Balance Persistence",
    description: "Follows persistent directional body structure when bullish/bearish candle dominance aligns with close acceptance.",
    defaultParams: {
        lookback: 30,
        balanceMin: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        balanceMin: "Min Body Balance",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        // bodyDirection: +1 bull, -1 bear, 0 flat
        const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
        // Shift from [-1,1] to [0,1] for rolling average (0.5 = balanced)
        const bodyDirNorm = bodyDir.map(v => (v + 1) / 2);
        const bodyBalance = buildRollingAverage(bodyDirNorm, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [bodyBalance], (i) => {
            const bb = bodyBalance[i];
            if (bb === null) return null;

            const balanceMin = p.balanceMin as number;
            const ca = closeAcceptance[i];

            if (bb > balanceMin && ca > 0) {
                return createBuySignal(cleanData, i, `Body balance ${bb.toFixed(2)} bullish dominance`);
            }
            if (bb < (1 - balanceMin) && ca < 0) {
                return createSellSignal(cleanData, i, `Body balance ${bb.toFixed(2)} bearish dominance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "balanceMin"],
    },
};
