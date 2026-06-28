import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        autocorrMin: Math.max(0.1, Math.min(0.95, Number(params.autocorrMin ?? 0.40))),
        volumePercentileMin: Math.max(0.1, Math.min(0.95, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const autocorrelation_proxy_volume_persistence: Strategy = {
    name: "Autocorrelation Proxy-Volume Persistence",
    description: "Follows persistent directional coupling when return autocorrelation is high and proxy volume supports the binding leg.",
    defaultParams: {
        lookback: 30,
        autocorrMin: 0.40,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Min Autocorrelation",
        volumePercentileMin: "Min Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        // 1-bar returns for autocorrelation
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);

        // Proxy volume percentile rank
        const volPctl = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [autocorr, volPctl], (i) => {
            const ac = autocorr[i];
            const vp = volPctl[i];
            if (ac === null || vp === null) return null;
            if (ac < (p.autocorrMin as number)) return null;
            if (vp < (p.volumePercentileMin as number)) return null;

            const ret = returnsClean[i];
            // Buy: positive return with persistent autocorrelation + volume
            if (ret > 0) {
                return createBuySignal(cleanData, i, `Autocorr ${ac.toFixed(2)} vol pctl ${vp.toFixed(2)} positive return`);
            }
            // Sell: negative return with persistent autocorrelation + volume
            if (ret < 0) {
                return createSellSignal(cleanData, i, `Autocorr ${ac.toFixed(2)} vol pctl ${vp.toFixed(2)} negative return`);
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
