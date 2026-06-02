import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingEntropy } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming input parameters are sanitized and standard indicator arrays are computed correctly without future leaks.
// #SUGGEST_VERIFY: Check standard testing with manual array comparison and assert zero future leakage.
function normalizeVwapDeviationEntropyGatedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyThreshold: Math.max(0.01, Number(params.entropyThreshold ?? 0.5)),
    };
}

export const vwap_deviation_entropy_gated: Strategy = {
    name: "VWAP Deviation Entropy Gated",
    description: "Signals when close price crosses above or below VWAP when rolling entropy of returns is below a regime threshold.",
    defaultParams: {
        lookback: 30,
        entropyThreshold: 0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams: normalizeVwapDeviationEntropyGatedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVwapDeviationEntropyGatedParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const returns = getReturns(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);

        return createSignalLoop(cleanData, [vwap, entropy], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const ent = entropy[i];

            if (currentVwap === null || prevVwap === null || ent === null) return null;
            if (ent >= p.entropyThreshold) return null;

            // Bullish crossover: Close price crosses above VWAP
            if (prevClose <= prevVwap && currentClose > currentVwap) {
                return createBuySignal(cleanData, i, `VWAP Crossover Above Gated by Low Entropy (ent=${ent.toFixed(3)})`);
            }
            // Bearish crossover: Close price crosses below VWAP
            if (prevClose >= prevVwap && currentClose < currentVwap) {
                return createSellSignal(cleanData, i, `VWAP Crossover Below Gated by Low Entropy (ent=${ent.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
