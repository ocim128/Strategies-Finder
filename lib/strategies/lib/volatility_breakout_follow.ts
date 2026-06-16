import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingStdDev,
    buildRollingMedian,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0.01, Number(params.zThreshold ?? 1.8)),
    };
}

export const volatility_breakout_follow: Strategy = {
    name: "Volatility Breakout Follow",
    description: "Follows price breakouts only when return volatility crosses above its rolling median, indicating transition to a trending expansion regime.",
    defaultParams: {
        lookback: 30,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Typical Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);

        const volMedian = buildRollingMedian(volClean, lookback);

        const typical = getTypicalPrices(cleanData);
        const typicalZ = buildRollingZScore(typical, lookback);

        return createSignalLoop(cleanData, [typicalZ, volMedian], (i) => {
            const tz = typicalZ[i];
            const vm = volMedian[i];
            if (tz === null || vm === null) return null;

            const v = volClean[i];

            // Buy: typical price z-score breakout and volatility > median volatility
            if (tz > p.zThreshold && v > vm) {
                return createBuySignal(cleanData, i, `Volatility breakout buy follow: Typical Z ${tz.toFixed(2)}, Vol ${v.toFixed(4)} > Median ${vm.toFixed(4)}`);
            }
            // Sell: typical price z-score breakdown and volatility > median volatility
            if (tz < -p.zThreshold && v > vm) {
                return createSellSignal(cleanData, i, `Volatility breakout sell follow: Typical Z ${tz.toFixed(2)}, Vol ${v.toFixed(4)} > Median ${vm.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
