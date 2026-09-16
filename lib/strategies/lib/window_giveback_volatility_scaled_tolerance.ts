import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRangeSeries,
    buildRollingAverage,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        high_vol_giveback_max: Math.max(0.05, Math.min(0.5, Number(params.high_vol_giveback_max ?? 0.25))),
    };
}

export const window_giveback_volatility_scaled_tolerance: Strategy = {
    name: "Window Giveback Volatility Scaled Tolerance",
    description: "Adapts giveback tolerance dynamically against instantaneous bar volatility relative to rolling average range.",
    defaultParams: {
        high_vol_giveback_max: 0.25,
    },
    paramLabels: {
        high_vol_giveback_max: "High-Vol Giveback Max",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const highVolMax = Number(params.high_vol_giveback_max);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, 20);
        const ranges = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(ranges, 20);

        return createSignalLoop(cleanData, [gb, avgRange], (i) => {
            if (i < 20) return null;
            const g = gb[i];
            const ar = avgRange[i];
            if (g === null || ar === null) return null;

            const barRange = cleanData[i].high - cleanData[i].low;

            if (closes[i] > closes[i - 20] && cleanData[i].close > cleanData[i].open) {
                if ((barRange > ar && g <= highVolMax) || (barRange <= ar && g <= 0.50)) {
                    return createBuySignal(cleanData, i, `Bullish volatility-scaled giveback: range=${barRange.toFixed(2)}, giveback=${g.toFixed(2)}`);
                }
            }

            if (closes[i] < closes[i - 20] && cleanData[i].close < cleanData[i].open) {
                if ((barRange > ar && g <= highVolMax) || (barRange <= ar && g <= 0.50)) {
                    return createSellSignal(cleanData, i, `Bearish volatility-scaled giveback: range=${barRange.toFixed(2)}, giveback=${g.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["high_vol_giveback_max"],
    },
};
