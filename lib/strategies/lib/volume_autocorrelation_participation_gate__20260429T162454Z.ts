import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeVolumeAutocorrelationParticipationGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        vol_corr_lookback: Math.max(3, Math.round(Number(params.vol_corr_lookback ?? 20))),
        price_lookback: Math.max(2, Math.round(Number(params.price_lookback ?? 55))),
    };
}

export const volume_autocorrelation_participation_gate: Strategy = {
    name: "Volume Autocorrelation Participation Gate",
    description:
        "Uses persistent serial correlation in volume as a participation gate and only accepts breakouts once settlement clears the prior trailing range.",
    defaultParams: {
        vol_corr_lookback: 20,
        price_lookback: 55,
    },
    paramLabels: {
        vol_corr_lookback: "Volume Corr Lookback",
        price_lookback: "Price Lookback",
    },
    normalizeParams: normalizeVolumeAutocorrelationParticipationGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeAutocorrelationParticipationGateParams(params);
        const minBars = Math.max((p.vol_corr_lookback as number) + 1, p.price_lookback as number);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const autocorrelation = buildRollingAutoCorrelation(volumes, p.vol_corr_lookback as number);
        const { highest, lowest } = buildTrailingHighLow(cleanData, p.price_lookback as number);

        return createSignalLoop(cleanData, [autocorrelation, highest, lowest], (i) => {
            const autocorr = autocorrelation[i];
            const priorHigh = highest[i];
            const priorLow = lowest[i];
            if (autocorr === null || priorHigh === null || priorLow === null || autocorr <= 0.4) return null;

            if (closes[i] > priorHigh) {
                return createBuySignal(cleanData, i, `Volume autocorrelation ${autocorr.toFixed(2)} with breakout close above range`);
            }
            if (closes[i] < priorLow) {
                return createSellSignal(cleanData, i, `Volume autocorrelation ${autocorr.toFixed(2)} with breakdown close below range`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["vol_corr_lookback", "price_lookback"],
    },
};
