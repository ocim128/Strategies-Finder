import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        correlationThreshold: Number(params.correlationThreshold ?? 0.35),
    };
}

export const volume_correlation_trend_follow: Strategy = {
    name: "Volume Correlation Trend Follow",
    description: "Follows ratio momentum when correlation between return and proxy volume rank is strong.",
    defaultParams: {
        lookback: 30,
        correlationThreshold: 0.35,
    },
    paramLabels: {
        lookback: "Lookback Window",
        correlationThreshold: "Correlation Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const returnsClean = closeReturn.map((v) => v ?? 0);

        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);
        const volPctClean = volPct.map((v) => v ?? 0);

        const rollingCorr = buildRollingCorrelation(returnsClean, volPctClean, lookback);

        return createSignalLoop(cleanData, [rollingCorr, volPct], (i) => {
            const corr = rollingCorr[i];
            if (corr === null) return null;

            const cr = closeReturn[i];

            // Buy: positive correlation with volume, positive return
            if (corr > p.correlationThreshold && cr > 0) {
                return createBuySignal(cleanData, i, `Volume correlation trend buy: Corr ${corr.toFixed(2)}`);
            }
            // Sell: negative correlation with volume, negative return
            if (corr < -p.correlationThreshold && cr < 0) {
                return createSellSignal(cleanData, i, `Volume correlation trend sell: Corr ${corr.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationThreshold"],
    },
};
