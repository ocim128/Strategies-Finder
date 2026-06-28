import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        volPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.volPercentileMax ?? 0.40))),
    };
}

export const autocorrelation_compression_transition: Strategy = {
    name: "Autocorrelation Compression Transition",
    description: "Follows directional acceptance when autocorrelation crosses from negative to positive during compression.",
    defaultParams: {
        lookback: 25,
        volPercentileMax: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Max Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volPctl = buildPercentileRank(volStdDev.map(v => v ?? 0), lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [autocorr, volPctl], (i) => {
            if (i < 2) return null;
            const ac = autocorr[i];
            const acPrev = autocorr[i - 1];
            const vp = volPctl[i];
            if (ac === null || acPrev === null || vp === null) return null;

            // Crossed from negative to positive
            const crossedUp = acPrev < 0 && ac > 0;
            if (!crossedUp) return null;
            if (vp >= (p.volPercentileMax as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `AC transition ${acPrev.toFixed(2)}->${ac.toFixed(2)} vol pctl ${vp.toFixed(2)} bullish`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `AC transition ${acPrev.toFixed(2)}->${ac.toFixed(2)} vol pctl ${vp.toFixed(2)} bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax"],
    },
};
