import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    buildPercentileRank,
    buildRollingStdDev,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        expansionThreshold: Math.max(0, Math.min(1, Number(params.expansionThreshold ?? 0.85))),
    };
}

export const compression_ratio_expansion_follow: Strategy = {
    name: "Compression Ratio Expansion Follow",
    description: "Enters trend breakouts following a volatility compression phase.",
    defaultParams: {
        lookback: 30,
        expansionThreshold: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        expansionThreshold: "Expansion Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const stdDev = buildRollingStdDev(returns, lookback);

        const stdDevs: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const sd = stdDev[i];
            stdDevs[i] = sd !== null ? sd : 0;
        }

        const volPercentile = buildPercentileRank(stdDevs, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [stdDev, volPercentile], (i) => {
            const vp = volPercentile[i];
            if (vp === null) return null;

            // Check for compression in the previous 5 bars (excluding current bar)
            let hasCompression = false;
            for (let k = 1; k <= 5; k++) {
                const prevIdx = i - k;
                if (prevIdx >= 0) {
                    const prevP = volPercentile[prevIdx];
                    if (prevP !== null && prevP < 0.25) {
                        hasCompression = true;
                        break;
                    }
                }
            }

            if (!hasCompression) return null;

            const ret = returns[i];
            const cl = closeLocation[i];

            if (vp > p.expansionThreshold) {
                if (ret > 0 && cl > 0.6) {
                    return createBuySignal(cleanData, i, `Volatility breakout buy: percentile ${vp.toFixed(2)} with return ${ret.toFixed(4)} and CL ${cl.toFixed(2)}`);
                }
                if (ret < 0 && cl < 0.4) {
                    return createSellSignal(cleanData, i, `Volatility breakout sell: percentile ${vp.toFixed(2)} with return ${ret.toFixed(4)} and CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "expansionThreshold"],
    },
};
