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
    buildRollingEntropy,
} from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        volThreshold: Number(params.volThreshold ?? 0.7),
    };
}

export const entropy_gated_volatility_acceptance: Strategy = {
    name: "Entropy Gated Volatility Acceptance",
    description: "Enters in the direction of close acceptance during high volatility expansions when return entropy is low.",
    defaultParams: {
        lookback: 50,
        volThreshold: 0.7,
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
        const entropy = buildRollingEntropy(returns, lookback);
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [entropy, volPct, acceptance], (i) => {
            if (i < lookback) return null;
            const currentEntropy = entropy[i];
            const currentVolPct = volPct[i];
            const currentAccept = acceptance[i];
            if (currentEntropy === null || currentVolPct === null || currentAccept === null) return null;

            const volThresh = p.volThreshold as number;

            // Buy: vol percentile > volThreshold, entropy < 0.45, close acceptance > 0
            if (currentVolPct > volThresh && currentEntropy < 0.45 && currentAccept > 0) {
                return createBuySignal(cleanData, i, `Entropy Gated Vol Buy: VolPct ${currentVolPct.toFixed(2)}, Entropy ${currentEntropy.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }
            // Sell: vol percentile > volThreshold, entropy < 0.45, close acceptance < 0
            if (currentVolPct > volThresh && currentEntropy < 0.45 && currentAccept < 0) {
                return createSellSignal(cleanData, i, `Entropy Gated Vol Sell: VolPct ${currentVolPct.toFixed(2)}, Entropy ${currentEntropy.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
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
