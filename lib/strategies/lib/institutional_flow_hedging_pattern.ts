import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRollingAutoCorrelation, extractBarMetricSeries, buildRateOfChange } from "./price-action-statistics-core";

function normalizeInstitutionalFlowHedgingPatternParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        autocorrMin: Math.max(0, Math.min(1, Number(params.autocorrMin ?? 0.30))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.50))),
    };
}

export const institutional_flow_hedging_pattern: Strategy = {
    name: "Institutional Flow Hedging Pattern",
    description: "Institutional positioning flow detection via body direction autocorrelation with proxy volume check.",
    defaultParams: {
        lookback: 30,
        autocorrMin: 0.30,
        volumePercentileMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Autocorr Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeInstitutionalFlowHedgingPatternParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInstitutionalFlowHedgingPatternParams(params);
        const lookback = p.lookback as number;
        const autocorrMin = p.autocorrMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
        const autocorr = buildRollingAutoCorrelation(bodyDir, lookback, 1);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);
        const returns = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [autocorr, volumePercentile, returns], (i) => {
            const ac = autocorr[i];
            const volPct = volumePercentile[i];
            const ret = returns[i];
            if (ac === null || volPct === null || ret === null) return null;

            if (ac > autocorrMin && volPct > volumePercentileMin) {
                if (ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Institutional flow buy: autocorr ${ac.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
                if (ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Institutional flow sell: autocorr ${ac.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrMin", "volumePercentileMin"],
    },
};
