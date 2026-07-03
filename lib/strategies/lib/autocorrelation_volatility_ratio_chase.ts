import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingStdDev,
    buildPercentileRank,
    buildRollingAutoCorrelation,
} from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 45))),
        volThreshold: Number(params.volThreshold ?? 0.65),
    };
}

export const autocorrelation_volatility_ratio_chase: Strategy = {
    name: "Autocorrelation Volatility Ratio Chase",
    description: "Trend-chasing in volatility expansions when return autocorrelation confirms momentum persistence and close acceptance is aligned.",
    defaultParams: {
        lookback: 45,
        volThreshold: 0.65,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThreshold: "Vol Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [ac, volPct, acceptance], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentVolPct = volPct[i];
            const currentAccept = acceptance[i];
            if (currentAc === null || currentVolPct === null || currentAccept === null) return null;

            const volThresh = p.volThreshold as number;

            // Buy: vol percentile > volThreshold, autocorrelation > 0.25, close acceptance > 0
            if (currentVolPct > volThresh && currentAc > 0.25 && currentAccept > 0) {
                return createBuySignal(cleanData, i, `Auto Vol Ratio Chase Buy: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }
            // Sell: vol percentile > volThreshold, autocorrelation > 0.25, close acceptance < 0
            if (currentVolPct > volThresh && currentAc > 0.25 && currentAccept < 0) {
                return createSellSignal(cleanData, i, `Auto Vol Ratio Chase Sell: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThreshold"],
    },
};
