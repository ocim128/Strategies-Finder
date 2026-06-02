import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

const _returns = new WeakMap<OHLCVData[], number[]>();
function getReturns(data: OHLCVData[]): number[] {
    let r = _returns.get(data);
    if (!r) {
        const closes = getCloses(data);
        r = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            r[i] = closes[i] - closes[i - 1];
        }
        _returns.set(data, r);
    }
    return r;
}

// #COMPLETION_DRIVE: Assuming rolling average of close location and return entropy percentile rank are robust indicators of low-volatility stealth accumulation.
// #SUGGEST_VERIFY: Verify return entropy percentile bounds and close-location threshold properties in standard simulation.
function normalizeLowEntropyCloseLocationIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        clsLocThreshold: Math.max(0.5, Math.min(0.99, Number(params.clsLocThreshold ?? 0.7))),
    };
}

export const low_entropy_close_location_ignition: Strategy = {
    name: "Low Entropy Close Location Ignition",
    description: "Captures low-entropy close-location alignment under extreme return entropy compression, signaling a quiet, highly organized launch.",
    defaultParams: {
        lookback: 35,
        clsLocThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        clsLocThreshold: "Close Location Threshold",
    },
    normalizeParams: normalizeLowEntropyCloseLocationIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLowEntropyCloseLocationIgnitionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);

        const returns = getReturns(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);
        
        // Coerce nulls in entropy to 0 before computing percentile rank
        const entropyClean = entropy.map(v => v ?? 0);
        const entropyRank = buildPercentileRank(entropyClean, lookback);

        return createSignalLoop(cleanData, [avgCloseLoc, entropyRank], (i) => {
            if (i < lookback) return null;
            const currentAvgLoc = avgCloseLoc[i];
            const currentRank = entropyRank[i];

            if (currentAvgLoc === null || currentRank === null) return null;

            // Gate entry when return entropy is in the bottom 30% of its history
            if (currentRank < 0.3) {
                // Bullish: Rolling average close location is greater than clsLocThreshold
                if (currentAvgLoc > p.clsLocThreshold) {
                    return createBuySignal(cleanData, i, `Low Entropy Close Location Bullish (avgLoc=${currentAvgLoc.toFixed(3)}, entropyRank=${(currentRank * 100).toFixed(0)}%)`);
                }
                // Bearish: Rolling average close location is less than 1 minus clsLocThreshold
                if (currentAvgLoc < 1 - (p.clsLocThreshold as number)) {
                    return createSellSignal(cleanData, i, `Low Entropy Close Location Bearish (avgLoc=${currentAvgLoc.toFixed(3)}, entropyRank=${(currentRank * 100).toFixed(0)}%)`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clsLocThreshold"],
    },
};
