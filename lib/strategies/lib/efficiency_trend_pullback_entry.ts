import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyTrendPullbackEntryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.45))),
    };
}

export const efficiency_trend_pullback_entry: Strategy = {
    name: "Efficiency Trend Pullback Entry",
    description: "Pullback entry in efficiency-confirmed trend.",
    defaultParams: {
        lookback: 25,
        efficiencyMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeEfficiencyTrendPullbackEntryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyTrendPullbackEntryParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const rollingMedian = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [efficiencyRatio, rollingMedian, returns], (i) => {
            const eff = efficiencyRatio[i];
            const med = rollingMedian[i];
            const ret = returns[i];
            if (eff === null || med === null || ret === null) return null;

            const close = closes[i];
            if (eff > efficiencyMin) {
                // Uptrend pullback: close > rollingMedian (uptrend) and ret < 0 (pullback)
                if (close > med && ret < 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Pullback buy: efficiency ${eff.toFixed(2)}, close ${close.toFixed(4)} > median ${med.toFixed(4)}, ret ${ret.toFixed(4)}`
                    );
                }
                // Downtrend pullback: close < rollingMedian (downtrend) and ret > 0 (pullback)
                if (close < med && ret > 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Pullback sell: efficiency ${eff.toFixed(2)}, close ${close.toFixed(4)} < median ${med.toFixed(4)}, ret ${ret.toFixed(4)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin"],
    },
};
