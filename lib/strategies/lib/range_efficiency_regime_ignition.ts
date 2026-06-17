import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        efficiencyMin: Math.max(0.01, Math.min(0.99, Number(params.efficiencyMin ?? 0.60))),
        rangePercentileMin: Math.max(0.01, Math.min(0.99, Number(params.rangePercentileMin ?? 0.75))),
    };
}

export const range_efficiency_regime_ignition: Strategy = {
    name: "Range Efficiency Regime Ignition",
    description: "Follows direction when efficiency ratio spikes alongside a high range percentile rank, confirming directed volatility expansion.",
    defaultParams: {
        lookback: 30,
        efficiencyMin: 0.60,
        rangePercentileMin: 0.75,
    },
    paramLabels: {
        lookback: "Lookback Window",
        efficiencyMin: "Min Efficiency",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const ranges = buildRangeSeries(cleanData);
        const rangePct = buildPercentileRank(ranges, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [efficiency, rangePct], (i) => {
            const eff = efficiency[i];
            const rp = rangePct[i];
            if (eff === null || rp === null) return null;

            const cl = closeLoc[i];

            // Buy: efficiency high, range expansion high, and closeLocation > 0.70
            if (eff > p.efficiencyMin && rp > p.rangePercentileMin && cl > 0.70) {
                return createBuySignal(cleanData, i, `Range efficiency ignition buy: Eff ${eff.toFixed(2)}, Range Pct ${rp.toFixed(2)}`);
            }
            // Sell: efficiency high, range expansion high, and closeLocation < 0.30
            if (eff > p.efficiencyMin && rp > p.rangePercentileMin && cl < 0.30) {
                return createSellSignal(cleanData, i, `Range efficiency ignition sell: Eff ${eff.toFixed(2)}, Range Pct ${rp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin", "rangePercentileMin"],
    },
};
