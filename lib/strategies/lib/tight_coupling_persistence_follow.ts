import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeTightCouplingPersistenceFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        rangePercentileMax: Math.max(0, Math.min(1, Number(params.rangePercentileMax ?? 0.30))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.50))),
    };
}

export const tight_coupling_persistence_follow: Strategy = {
    name: "Tight Coupling Persistence Follow",
    description: "Tight coupling persistence enabled by modern arbitrage.",
    defaultParams: {
        lookback: 30,
        rangePercentileMax: 0.30,
        efficiencyMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMax: "Range Percentile Max",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeTightCouplingPersistenceFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTightCouplingPersistenceFollowParams(params);
        const lookback = p.lookback as number;
        const rangePercentileMax = p.rangePercentileMax as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [rangePercentile, efficiencyRatio], (i) => {
            const rngPct = rangePercentile[i];
            const eff = efficiencyRatio[i];
            if (rngPct === null || eff === null) return null;

            if (rngPct < rangePercentileMax && eff > efficiencyMin) {
                if (closeAcceptance[i] > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Tight coupling buy: range percentile ${rngPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
                if (closeAcceptance[i] < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Tight coupling sell: range percentile ${rngPct.toFixed(2)}, efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMax", "efficiencyMin"],
    },
};
