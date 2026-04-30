import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeDecayingBoundaryMomentumCaptureParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.95))),
    };
}

export const decaying_boundary_momentum_capture: Strategy = {
    name: "Decaying Boundary Momentum Capture",
    description:
        "Builds a decaying extreme-to-median boundary that tightens over time and triggers when price reclaims momentum through that shrinking threshold.",
    defaultParams: {
        lookback: 20,
        decay: 0.95,
    },
    paramLabels: {
        lookback: "Lookback",
        decay: "Decay",
    },
    normalizeParams: normalizeDecayingBoundaryMomentumCaptureParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDecayingBoundaryMomentumCaptureParams(params);
        const lookback = p.lookback as number;
        const decay = p.decay as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const signals: ReturnType<typeof createBuySignal>[] = [];

        let upperDecay = 1;
        let lowerDecay = 1;

        for (let i = lookback; i < cleanData.length; i++) {
            const mid = median[i - 1];
            const priorHigh = highest[i];
            const priorLow = lowest[i];
            if (mid === null || priorHigh === null || priorLow === null) {
                continue;
            }

            const upperBoundary = mid + (priorHigh - mid) * upperDecay;
            const lowerBoundary = mid - (mid - priorLow) * lowerDecay;
            const previousClose = closes[i - 1];
            const currentClose = closes[i];

            if (previousClose <= upperBoundary && currentClose > upperBoundary) {
                signals.push(createBuySignal(cleanData, i, "Close crossed above decaying upper boundary"));
            } else if (previousClose >= lowerBoundary && currentClose < lowerBoundary) {
                signals.push(createSellSignal(cleanData, i, "Close crossed below decaying lower boundary"));
            }

            // New extremes reset the boundary to the full trailing span; otherwise it decays toward the median.
            upperDecay = cleanData[i].high > priorHigh ? 1 : upperDecay * decay;
            lowerDecay = cleanData[i].low < priorLow ? 1 : lowerDecay * decay;
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay"],
    },
};
