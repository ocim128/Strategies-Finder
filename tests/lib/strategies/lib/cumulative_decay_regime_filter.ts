import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRateOfChange, buildCumulativeDecaySum, buildRollingZScore } from "./price-action-statistics-core";

export const cumulative_decay_regime_filter: Strategy = {
    name: "Cumulative Decay Regime Filter",
    description: "An exponentially decayed cumulative rate of change dictates deeply ingrained structural drift regimes. We trade purely when short-term price hits radical Z-score dips against this heavy dominant regime flow.",
    defaultParams: {
        roc_lookback: 3,
        decay_factor: 0.9,
        z_thresh: 1.5
    },
    paramLabels: {
        roc_lookback: "Velocity Span",
        decay_factor: "Structural Matrix Memory",
        z_thresh: "Re-Entry Pullback Extension"
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const rocLookback = params.roc_lookback as number;
        const decayFactor = params.decay_factor as number;
        const zThresh = params.z_thresh as number;

        if (cleanData.length < rocLookback + 50) return []; // Require reasonable state base to compute z-scores

        const closes = cleanData.map(d => d.close);
        const rocs = buildRateOfChange(closes, rocLookback);
        const validRocs = rocs.map(v => v === null ? 0 : v);

        // Accumulate exponential memory via simple signed RoC 
        const decayedRocSum = buildCumulativeDecaySum(validRocs, decayFactor);

        const zScores = buildRollingZScore(closes, 40); // Standard underlying parameter for local extension dips

        return createSignalLoop(cleanData, [decayedRocSum, zScores], (i) => {
            const regimeFlow = decayedRocSum[i - 1]; // Past bar maps current contextual playing field structurally
            if (regimeFlow === null) return null;

            const currentZScore = zScores[i];
            if (currentZScore === null) return null;

            // Buy: Evaluated statistically significant deep structural drift upwards mapped natively via decaying path, executing blindly against mathematically irrational micro price dips (- Z dips).
            if (regimeFlow > 0 && currentZScore < -zThresh) {
                return createBuySignal(cleanData, i, "Accumulated Matrix Drift Pullback Value Long");
            }

            // Sell: Evaluated strong bearish drift via decaying structure. Entering exclusively directly on massive pop spikes against the direction.
            if (regimeFlow < 0 && currentZScore > zThresh) {
                return createSellSignal(cleanData, i, "Accumulated Matrix Drift Premium Value Short");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["roc_lookback", "decay_factor", "z_thresh"]
    }
};
