import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        maxVolPercentile: Math.max(0.01, Math.min(0.99, Number(params.maxVolPercentile ?? 0.35))),
        acceptanceThreshold: Math.max(0.5, Math.min(0.99, Number(params.acceptanceThreshold ?? 0.70))),
    };
}

export const volatility_gated_close_acceptance: Strategy = {
    name: "Volatility Gated Close Acceptance",
    description: "Follows ratio drifts when close acceptance is extreme and return volatility is low (quiet accumulation/distribution).",
    defaultParams: {
        lookback: 30,
        maxVolPercentile: 0.35,
        acceptanceThreshold: 0.70,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxVolPercentile: "Max Vol Percentile",
        acceptanceThreshold: "Acceptance Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);

        const volPct = buildPercentileRank(volClean, lookback);

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const avgAcceptance = buildRollingAverage(acceptance, lookback);

        return createSignalLoop(cleanData, [volPct, avgAcceptance], (i) => {
            const vp = volPct[i];
            const avgAcc = avgAcceptance[i];
            if (vp === null || avgAcc === null) return null;

            // Buy: high close acceptance, low volatility
            if (avgAcc > p.acceptanceThreshold && vp < p.maxVolPercentile) {
                return createBuySignal(cleanData, i, `Volatility gated acceptance buy: Avg Acc ${avgAcc.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }
            // Sell: low close acceptance, low volatility
            if (avgAcc < (1 - p.acceptanceThreshold) && vp < p.maxVolPercentile) {
                return createSellSignal(cleanData, i, `Volatility gated acceptance sell: Avg Acc ${avgAcc.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxVolPercentile", "acceptanceThreshold"],
    },
};
