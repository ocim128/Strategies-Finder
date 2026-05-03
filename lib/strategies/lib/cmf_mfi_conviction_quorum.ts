import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
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
import { calculateCMF, calculateMFI } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeCmfMfiConvictionQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const cmf_mfi_conviction_quorum: Strategy = {
    name: "CMF MFI Conviction Quorum",
    description:
        "Requires Chaikin money flow and money flow index to agree with price relative to its rolling median.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCmfMfiConvictionQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfMfiConvictionQuorumParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const mfi = calculateMFI(highs, lows, closes, volumes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [cmf, mfi, median], (i) => {
            const flow = cmf[i];
            const moneyFlow = mfi[i];
            const med = median[i];
            if (flow === null || moneyFlow === null || med === null) return null;

            if (flow > 0 && moneyFlow > 50 && closes[i] > med) {
                return createBuySignal(cleanData, i, `CMF/MFI conviction long cmf=${flow.toFixed(3)} mfi=${moneyFlow.toFixed(1)}`);
            }
            if (flow < 0 && moneyFlow < 50 && closes[i] < med) {
                return createSellSignal(cleanData, i, `CMF/MFI conviction short cmf=${flow.toFixed(3)} mfi=${moneyFlow.toFixed(1)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
