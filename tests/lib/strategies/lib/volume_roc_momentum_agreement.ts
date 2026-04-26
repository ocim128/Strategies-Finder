import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeVolumeRocMomentumAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(params.lookback ?? 3)),
    };
}

export const volume_roc_momentum_agreement: Strategy = {
    name: "Volume ROC Momentum Agreement",
    description: "When price rate of change and volume rate of change agree in direction, momentum is confirmed by increasing participation. Both positive signals that buyers are both pushing price up and increasing activity; both negative signals seller conviction.",
    defaultParams: {
        lookback: 3,
    },
    paramLabels: {
        lookback: "ROC Period",
    },
    normalizeParams: normalizeVolumeRocMomentumAgreementParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeRocMomentumAgreementParams(params);
        if (cleanData.length < p.lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const priceRoc = buildRateOfChange(closes, p.lookback);
        const volumeRoc = buildRateOfChange(volumes, p.lookback);

        return createSignalLoop(cleanData, [priceRoc, volumeRoc], (i) => {
            if (i < p.lookback) return null;
            const pr = priceRoc[i];
            const vr = volumeRoc[i];
            if (pr === null || vr === null) return null;

            if (pr > 0 && vr > 0) {
                return createBuySignal(cleanData, i, `Price ROC +${(pr * 100).toFixed(2)}% and volume ROC +${(vr * 100).toFixed(2)}% agree bullish`);
            }
            if (pr < 0 && vr < 0) {
                return createSellSignal(cleanData, i, `Price ROC ${(pr * 100).toFixed(2)}% and volume ROC ${(vr * 100).toFixed(2)}% agree bearish`);
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
