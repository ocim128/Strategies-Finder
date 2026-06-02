import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateCMF } from "../indicators";
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

// #COMPLETION_DRIVE: Assuming rolling return entropy filters out noisy regimes reliably when money flow crosses breakout thresholds.
// #SUGGEST_VERIFY: Check standard testing with manual array comparison and assert zero future leakage.
function normalizeEntropyGatedCmfBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyThreshold: Math.max(0.01, Number(params.entropyThreshold ?? 0.45)),
    };
}

export const entropy_gated_cmf_breakout: Strategy = {
    name: "Entropy Gated CMF Breakout",
    description: "Signals when Chaikin Money Flow (CMF) reaches extreme thresholds while rolling return entropy is compressed, highlighting coordinated institutional edge.",
    defaultParams: {
        lookback: 30,
        entropyThreshold: 0.45,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams: normalizeEntropyGatedCmfBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyGatedCmfBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const returns = getReturns(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);

        return createSignalLoop(cleanData, [cmf, entropy], (i) => {
            if (i < lookback) return null;
            const currentCmf = cmf[i];
            const ent = entropy[i];

            if (currentCmf === null || ent === null) return null;
            if (ent >= p.entropyThreshold) return null;

            // Buy logic: CMF is above 0.25 while rolling return entropy is less than entropyThreshold
            if (currentCmf > 0.25) {
                return createBuySignal(cleanData, i, `Entropy Gated CMF Bullish Breakout (CMF=${currentCmf.toFixed(3)}, entropy=${ent.toFixed(3)})`);
            }

            // Sell logic: CMF is below -0.25 while rolling return entropy is less than entropyThreshold
            if (currentCmf < -0.25) {
                return createSellSignal(cleanData, i, `Entropy Gated CMF Bearish Breakout (CMF=${currentCmf.toFixed(3)}, entropy=${ent.toFixed(3)})`);
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
