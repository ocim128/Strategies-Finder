import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizePriceVolumeRankAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    };
}

export const price_volume_rank_agreement: Strategy = {
    name: "Price-Volume Rank Agreement",
    description: "When close and volume simultaneously occupy the same distribution tail, the move shows participation conviction instead of low-participation drift. Elevated volume confirms whether price-state occupancy matters.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizePriceVolumeRankAgreementParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeRankAgreementParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeRank = buildPercentileRank(getCloses(cleanData), lookback);
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [closeRank, volumeRank], (i) => {
            const cRank = closeRank[i];
            const vRank = volumeRank[i];
            if (cRank === null || vRank === null) return null;

            if (cRank > 0.5 && vRank > 0.5) {
                return createBuySignal(cleanData, i, `Close/volume upper-tail agreement (${(cRank * 100).toFixed(1)}%, ${(vRank * 100).toFixed(1)}%)`);
            }
            if (cRank < 0.5 && vRank > 0.5) {
                return createSellSignal(cleanData, i, `Weak close on elevated volume (${(cRank * 100).toFixed(1)}%, ${(vRank * 100).toFixed(1)}%)`);
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
