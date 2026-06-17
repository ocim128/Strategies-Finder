import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness, buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        skewChange: Number(params.skewChange ?? 0.80),
    };
}

export const skewness_reversal_momentum_ignite: Strategy = {
    name: "Skewness Reversal Momentum Ignite",
    description: "Follows momentum when return skewness reverses aggressively and typical price crosses its rolling median.",
    defaultParams: {
        lookback: 40,
        skewChange: 0.80,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewChange: "Skew Change Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = cleanData.map((bar) => bar.close);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const volSkew = buildRollingSkewness(returns, lookback);

        const typical = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typical, lookback);

        return createSignalLoop(cleanData, [volSkew, median], (i) => {
            const vs = volSkew[i];
            const m = median[i];
            if (vs === null || m === null || i < 2) return null;

            const vs2 = volSkew[i - 2];
            const mPrev = median[i - 1];
            if (vs2 === null || mPrev === null) return null;

            const tp = typical[i];
            const tpPrev = typical[i - 1];

            // Buy: typical crosses above rolling median AND return skewness increased by skewChange over last 2 bars
            if (tpPrev <= mPrev && tp > m && (vs - vs2) > p.skewChange) {
                return createBuySignal(cleanData, i, `Skewness reversal momentum buy: Skew change ${(vs - vs2).toFixed(2)}`);
            }
            // Sell: typical crosses below rolling median AND return skewness decreased by skewChange over last 2 bars
            if (tpPrev >= mPrev && tp < m && (vs - vs2) < -p.skewChange) {
                return createSellSignal(cleanData, i, `Skewness reversal momentum sell: Skew change ${(vs - vs2).toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewChange"],
    },
};
