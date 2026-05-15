import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateSMA } from "../indicators";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeChopBreakoutAdverseVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        chopLookback: Math.max(2, Math.round(params.chopLookback ?? 15)),
        minCrosses: Math.max(1, Math.round(params.minCrosses ?? 5)),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.025)),
    };
}

export const chop_breakout_adverse_veto: Strategy = {
    name: "Chop Breakout Adverse Veto",
    description: "Trades clean exits from high-frequency SMA chop unless Polymarket adverse pressure vetoes the breakout.",
    defaultParams: {
        chopLookback: 15,
        minCrosses: 5,
        maxAdverse: 0.025,
    },
    paramLabels: {
        chopLookback: "Chop Lookback",
        minCrosses: "Minimum Crosses",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeChopBreakoutAdverseVetoParams,
    polymarket1sConfig: {
        required: true,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeChopBreakoutAdverseVetoParams(params);
        const lookback = p.chopLookback as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const sma = calculateSMA(closes, lookback);
        const distance = closes.map((close, i) => {
            const average = sma[i];
            return average === null ? 0 : close - average;
        });
        const crosses = buildThresholdCrossingCount(distance, lookback, 0);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const pressure = buildPolymarket1sPressureGap(cleanData, context.polymarket1s);

        return createSignalLoop(cleanData, [sma, crosses], (i) => {
            if (i < lookback * 2 - 1) return null;
            const average = sma[i];
            const crossCount = crosses[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];
            if (average === null || crossCount === null || longAdverse === null || shortAdverse === null) return null;
            if (crossCount < (p.minCrosses as number)) return null;

            const buffer = trueRange[i] * 0.5;
            if (closes[i] > average + buffer && longAdverse <= (p.maxAdverse as number)) {
                return createBuySignal(cleanData, i, `Chop breakout adverse veto long crosses ${crossCount}`);
            }
            if (closes[i] < average - buffer && shortAdverse <= (p.maxAdverse as number)) {
                return createSellSignal(cleanData, i, `Chop breakout adverse veto short crosses ${crossCount}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["chopLookback", "minCrosses", "maxAdverse"],
    },
};
