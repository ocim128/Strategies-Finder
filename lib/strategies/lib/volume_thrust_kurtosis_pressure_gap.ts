import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildRollingKurtosis, buildRollingMinMax } from "./polymarket-1s-strategy-utils";

function normalizeVolumeThrustKurtosisPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 4),
        kurtosisThreshold: normalizeNumberParam(params.kurtosisThreshold, 4.5, 0),
        maxAdverse: normalizeNumberParam(params.maxAdverse, 0.03, 0),
    };
}

export const volume_thrust_kurtosis_pressure_gap: Strategy = {
    name: "Volume Thrust Kurtosis Pressure Gap",
    description: "Trades Binance boundary breaks with fat-tailed volume participation unless Polymarket adverse pressure has already priced the move.",
    defaultParams: {
        lookback: 30,
        kurtosisThreshold: 4.5,
        maxAdverse: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosisThreshold: "Kurtosis Threshold",
        maxAdverse: "Max Adverse Pressure",
    },
    normalizeParams: normalizeVolumeThrustKurtosisPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeThrustKurtosisPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const boundaries = buildRollingMinMax(closes, lookback, false);
        const volumeKurtosis = buildRollingKurtosis(volumes, lookback);
        const volumeZ = buildRollingZScore(volumes, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [
            boundaries.min,
            boundaries.max,
            volumeKurtosis,
            volumeZ,
            pressure.longAdverse,
            pressure.shortAdverse,
        ], (i) => {
            if (i < lookback) return null;
            if ((volumeKurtosis[i] ?? -Infinity) <= p.kurtosisThreshold || (volumeZ[i] ?? -Infinity) <= 0) return null;

            if (closes[i] > (boundaries.max[i] ?? Infinity) && (pressure.longAdverse[i] ?? Infinity) <= p.maxAdverse) {
                return createBuySignal(cleanData, i, "Volume thrust breakout with controlled long pressure gap");
            }
            if (closes[i] < (boundaries.min[i] ?? -Infinity) && (pressure.shortAdverse[i] ?? Infinity) <= p.maxAdverse) {
                return createSellSignal(cleanData, i, "Volume thrust breakdown with controlled short pressure gap");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisThreshold", "maxAdverse"],
    },
};
