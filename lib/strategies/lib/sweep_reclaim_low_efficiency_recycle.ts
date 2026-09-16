import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        max_efficiency: Math.max(0.05, Math.min(1.0, Number(params.max_efficiency ?? 0.30))),
    };
}

export const sweep_reclaim_low_efficiency_recycle: Strategy = {
    name: "Sweep Reclaim Low Efficiency Recycle",
    description: "Takes boundary sweep reclaims strictly in low-efficiency rotational regimes.",
    defaultParams: {
        max_efficiency: 0.30,
    },
    paramLabels: {
        max_efficiency: "Maximum Efficiency Ratio",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const maxEfficiency = Number(params.max_efficiency);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);
        const eff = buildEfficiencyRatio(cleanData, 10);

        return createSignalLoop(cleanData, [sweepScores, eff], (i) => {
            const score = sweepScores[i];
            const e = eff[i];
            if (score === null || e === null) return null;

            if (e <= maxEfficiency) {
                if (score >= 0.20) {
                    return createBuySignal(cleanData, i, `Bullish low-efficiency sweep recycle: score=${score.toFixed(2)}>=0.20, eff=${e.toFixed(2)}<=${maxEfficiency}`);
                }
                if (score <= -0.20) {
                    return createSellSignal(cleanData, i, `Bearish low-efficiency sweep recycle: score=${score.toFixed(2)}<=-0.20, eff=${e.toFixed(2)}<=${maxEfficiency}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_efficiency"],
    },
};
