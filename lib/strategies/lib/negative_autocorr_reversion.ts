import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingAutoCorrelation,
    buildRollingZScore,
} from "./price-action-statistics-core";

const AUTOCORR_CERTIFICATE = -0.2;
const Z_FADE_DEPTH = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 40))),
    };
}

export const negative_autocorr_reversion: Strategy = {
    name: "Negative Autocorrelation Reversion",
    description: "Fades z-score extremes only when lag-1 return autocorrelation certifies a measured anti-persistent regime.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        // One-bar returns with the leading null coerced so the autocorrelation
        // estimate never sees non-finite pairs.
        const returns = buildRateOfChange(closes, 1).map((v) => (v === null ? 0 : v));
        const autocorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const z = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [autocorr, z], (i) => {
            const ac = autocorr[i];
            const zNow = z[i];
            if (ac === null || zNow === null || !Number.isFinite(ac)) return null;

            if (ac <= AUTOCORR_CERTIFICATE && zNow <= -Z_FADE_DEPTH) {
                return createBuySignal(cleanData, i, `Anti-persistence buy: autocorr ${ac.toFixed(2)}, z ${zNow.toFixed(2)}`);
            }
            if (ac <= AUTOCORR_CERTIFICATE && zNow >= Z_FADE_DEPTH) {
                return createSellSignal(cleanData, i, `Anti-persistence sell: autocorr ${ac.toFixed(2)}, z ${zNow.toFixed(2)}`);
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
