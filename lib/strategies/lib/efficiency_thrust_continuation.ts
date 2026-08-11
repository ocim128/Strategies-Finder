import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

const EFFICIENT_THRESHOLD = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const efficiency_thrust_continuation: Strategy = {
    name: "Efficiency Thrust Continuation",
    description: "Buys on the fresh cross into an efficient (orderly) up-trend regime and sells the mirror for down trends.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Efficiency Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const eff = efficiency[i];
            const effPrev = efficiency[i - 1];
            if (eff === null) return null;

            // Fresh cross into the efficient regime: the previous bar was not
            // certified efficient (or had no reading), and the net move over the
            // window points up.
            const upThrust = eff >= EFFICIENT_THRESHOLD && (effPrev === null || effPrev < EFFICIENT_THRESHOLD) && closes[i] > closes[i - lookback];
            const downThrust = eff >= EFFICIENT_THRESHOLD && (effPrev === null || effPrev < EFFICIENT_THRESHOLD) && closes[i] < closes[i - lookback];

            if (upThrust) {
                return createBuySignal(cleanData, i, `Efficiency thrust buy: ER ${eff.toFixed(2)} crossed into efficient up regime`);
            }
            if (downThrust) {
                return createSellSignal(cleanData, i, `Efficiency thrust sell: ER ${eff.toFixed(2)} crossed into efficient down regime`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
