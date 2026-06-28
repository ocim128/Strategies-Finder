import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        momentumLookback: Math.max(1, Math.round(Number(params.momentumLookback ?? 5))),
        volPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.volPercentileMin ?? 0.70))),
    };
}

export const volatility_regime_acceptance_follow: Strategy = {
    name: "Volatility Regime Acceptance Follow",
    description: "Follows directional acceptance during high-volatility percentile regimes when momentum agrees.",
    defaultParams: {
        lookback: 30,
        momentumLookback: 5,
        volPercentileMin: 0.70,
    },
    paramLabels: {
        lookback: "Lookback",
        momentumLookback: "Momentum Lookback",
        volPercentileMin: "Min Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const momLookback = p.momentumLookback as number;
        if (cleanData.length < lookback + momLookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volPctl = buildPercentileRank(volStdDev.map(v => v ?? 0), lookback);
        const momentum = buildRateOfChange(closes, momLookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPctl, momentum], (i) => {
            const vp = volPctl[i];
            const mom = momentum[i];
            if (vp === null || mom === null) return null;
            if (vp < (p.volPercentileMin as number)) return null;

            const ca = closeAcceptance[i];
            if (mom > 0 && ca > 0) {
                return createBuySignal(cleanData, i, `Vol regime pctl ${vp.toFixed(2)} mom ${(mom * 100).toFixed(2)}% bullish acceptance`);
            }
            if (mom < 0 && ca < 0) {
                return createSellSignal(cleanData, i, `Vol regime pctl ${vp.toFixed(2)} mom ${(mom * 100).toFixed(2)}% bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "momentumLookback", "volPercentileMin"],
    },
};
