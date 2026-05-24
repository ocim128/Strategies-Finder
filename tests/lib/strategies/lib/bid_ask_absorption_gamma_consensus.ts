import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeBidAskAbsorptionGammaConsensusParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        volThreshold: normalizeNumberParam(params.volThreshold, 1.2, 0),
    };
}

export const bid_ask_absorption_gamma_consensus: Strategy = {
    name: "Bid-Ask Absorption with Gamma Consensus",
    description: "Looks for high-volume compressed-range absorption at rolling typical-price extremes with Gamma consensus permission from Polymarket.",
    defaultParams: {
        lookback: 20,
        volThreshold: 1.2,
    },
    paramLabels: {
        lookback: "Lookback",
        volThreshold: "Volume Z-Score Threshold",
    },
    normalizeParams: normalizeBidAskAbsorptionGammaConsensusParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeBidAskAbsorptionGammaConsensusParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const trueRangeZ = buildRollingZScore(extractBarMetricSeries(cleanData, "trueRange"), lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, volumeZ, trueRangeZ], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const volumeScore = volumeZ[i];
            const rangeScore = trueRangeZ[i];
            if (low === null || high === null || volumeScore === null || rangeScore === null) return null;
            if (volumeScore < p.volThreshold || rangeScore > -1.0) return null;

            if (typicals[i] <= low && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-volume compressed-range absorption at low with Gamma consensus");
            }
            if (typicals[i] >= high && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-volume compressed-range absorption at high with Gamma consensus");
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
