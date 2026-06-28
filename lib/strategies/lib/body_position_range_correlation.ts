import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        correlationMin: Math.max(0.1, Math.min(0.95, Number(params.correlationMin ?? 0.30))),
    };
}

export const body_position_range_correlation: Strategy = {
    name: "Body Position Range Correlation",
    description: "Follows directional moves when body-to-range position correlates with close return over a rolling window.",
    defaultParams: {
        lookback: 30,
        correlationMin: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMin: "Min Correlation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const corr = buildRollingCorrelation(bodyPct, returnsClean, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null) return null;
            if (c < (p.correlationMin as number)) return null;

            const ret = returnsClean[i];
            if (ret > 0) {
                return createBuySignal(cleanData, i, `Body-range corr ${c.toFixed(2)} positive return ${(ret * 100).toFixed(3)}%`);
            }
            if (ret < 0) {
                return createSellSignal(cleanData, i, `Body-range corr ${c.toFixed(2)} negative return ${(ret * 100).toFixed(3)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMin"],
    },
};
