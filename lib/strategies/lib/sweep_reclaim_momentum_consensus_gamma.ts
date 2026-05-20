import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildSweepReclaimSeries } from "./polymarket-1s-strategy-utils";

function normalizeSweepReclaimMomentumConsensusGammaParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 2),
        reclaimThreshold: normalizeNumberParam(params.reclaimThreshold, 0.70, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const sweep_reclaim_momentum_consensus_gamma: Strategy = {
    name: "Sweep Reclaim Momentum Consensus Gamma",
    description: "Trades Binance sweep-reclaims only when Gamma consensus confirms the same-side edge.",
    defaultParams: {
        lookback: 20,
        reclaimThreshold: 0.70,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        reclaimThreshold: "Reclaim Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams: normalizeSweepReclaimMomentumConsensusGammaParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeSweepReclaimMomentumConsensusGammaParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const reclaim = buildSweepReclaimSeries(cleanData, lookback);
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: lookback });
        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < lookback) return null;
            if (reclaim[i] >= p.reclaimThreshold && (gamma.consensusLongEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Bullish sweep reclaim with long Gamma consensus");
            }
            if (reclaim[i] <= -p.reclaimThreshold && (gamma.consensusShortEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Bearish sweep reclaim with short Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "reclaimThreshold", "minEdge"],
    },
};
