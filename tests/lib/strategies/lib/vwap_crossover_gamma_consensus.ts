import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateVWAP } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";

function normalizeVwapCrossoverGammaConsensusParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 2),
        volLookback: normalizeIntegerParam(params.volLookback, 40, 5),
    };
}

export const vwap_crossover_gamma_consensus: Strategy = {
    name: "VWAP Crossover with Gamma Consensus",
    description: "Trades close/VWAP crossovers only when the Polymarket Gamma consensus mask agrees with the direction.",
    defaultParams: {
        lookback: 30,
        volLookback: 40,
    },
    paramLabels: {
        lookback: "VWAP Lookback",
        volLookback: "Gamma Volatility Lookback",
    },
    normalizeParams: normalizeVwapCrossoverGammaConsensusParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVwapCrossoverGammaConsensusParams(params);
        if (cleanData.length < Math.max(p.lookback, p.volLookback) + 1) return [];

        const closes = getCloses(cleanData);
        const vwap = calculateVWAP(getHighs(cleanData), getLows(cleanData), closes, getVolumes(cleanData), p.lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: p.volLookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [vwap], (i) => {
            const currentVwap = vwap[i];
            const previousVwap = vwap[i - 1];
            if (currentVwap === null || previousVwap === null) return null;

            if (closes[i - 1] <= previousVwap && closes[i] > currentVwap && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Close crossed above VWAP with Gamma consensus");
            }
            if (closes[i - 1] >= previousVwap && closes[i] < currentVwap && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Close crossed below VWAP with Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volLookback"],
    },
};
