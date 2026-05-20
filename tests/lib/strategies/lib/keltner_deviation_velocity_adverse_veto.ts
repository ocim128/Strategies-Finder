import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeKeltnerDeviationVelocityAdverseVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        keltnerLookback: normalizeIntegerParam(params.keltnerLookback, 25, 2),
        atrMultiplier: normalizeNumberParam(params.atrMultiplier, 2.0, 0.1),
        maxAdverse: normalizeNumberParam(params.maxAdverse, 0.03, 0),
    };
}

export const keltner_deviation_velocity_adverse_veto: Strategy = {
    name: "Keltner Deviation Velocity Adverse Veto",
    description: "Fades extreme Binance Keltner pierces with high ROC only when Polymarket adverse pressure remains controlled.",
    defaultParams: {
        keltnerLookback: 25,
        atrMultiplier: 2.0,
        maxAdverse: 0.03,
    },
    paramLabels: {
        keltnerLookback: "Keltner Lookback",
        atrMultiplier: "ATR Multiplier",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeKeltnerDeviationVelocityAdverseVetoParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeKeltnerDeviationVelocityAdverseVetoParams(params);
        const lookback = p.keltnerLookback;
        if (cleanData.length < lookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const keltner = calculateKeltnerChannels(highs, lows, closes, lookback, lookback, p.atrMultiplier);
        const roc = buildRateOfChange(closes, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [keltner.upper, keltner.lower, roc, pressure.longAdverse, pressure.shortAdverse], (i) => {
            if (i < lookback) return null;

            if (
                closes[i] < (keltner.lower[i] ?? -Infinity)
                && (roc[i] ?? Infinity) < -0.002
                && (pressure.longAdverse[i] ?? Infinity) <= p.maxAdverse
            ) {
                return createBuySignal(cleanData, i, "Keltner lower deviation with controlled long adverse pressure");
            }
            if (
                closes[i] > (keltner.upper[i] ?? Infinity)
                && (roc[i] ?? -Infinity) > 0.002
                && (pressure.shortAdverse[i] ?? Infinity) <= p.maxAdverse
            ) {
                return createSellSignal(cleanData, i, "Keltner upper deviation with controlled short adverse pressure");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["keltnerLookback", "atrMultiplier", "maxAdverse"],
    },
};
