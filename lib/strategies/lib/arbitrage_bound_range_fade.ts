import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeArbitrageBoundRangeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        rangePercentileMin: Math.max(0, Math.min(1, Number(params.rangePercentileMin ?? 0.85))),
        efficiencyMax: Math.max(0, Math.min(1, Number(params.efficiencyMax ?? 0.30))),
    };
}

export const arbitrage_bound_range_fade: Strategy = {
    name: "Arbitrage-Bound Range Fade",
    description: "Range expansion fade enabled by modern arbitrage bounds.",
    defaultParams: {
        lookback: 30,
        rangePercentileMin: 0.85,
        efficiencyMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Range Percentile Min",
        efficiencyMax: "Efficiency Max",
    },
    normalizeParams: normalizeArbitrageBoundRangeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeArbitrageBoundRangeFadeParams(params);
        const lookback = p.lookback as number;
        const rangePercentileMin = p.rangePercentileMin as number;
        const efficiencyMax = p.efficiencyMax as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [rangePercentile, efficiencyRatio, returns], (i) => {
            const rngPct = rangePercentile[i];
            const eff = efficiencyRatio[i];
            const ret = returns[i];
            if (rngPct === null || eff === null || ret === null) return null;

            if (rngPct > rangePercentileMin && eff < efficiencyMax) {
                if (ret < 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Arbitrage-bound range fade buy: range percentile ${rngPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
                if (ret > 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Arbitrage-bound range fade sell: range percentile ${rngPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin", "efficiencyMax"],
    },
};
