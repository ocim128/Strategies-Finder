import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeVolumeDispersionReversionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        devMultiplier: normalizeNumberParam(params.devMultiplier, 2.0, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const volume_dispersion_reversion_pressure_gap: Strategy = {
    name: "Volume Dispersion Reversion with Pressure Gap",
    description: "Fades ATR-sized typical-price extremes only when volume dispersion is steady and Polymarket pressure shows same-side underpricing.",
    defaultParams: {
        lookback: 30,
        devMultiplier: 2.0,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        devMultiplier: "Deviation ATR Multiplier",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeVolumeDispersionReversionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeDispersionReversionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback * 2) return [];

        const typicals = getTypicalPrices(cleanData);
        const average = buildRollingAverage(typicals, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), lookback);
        const volumeStdDev = buildRollingStdDev(getVolumes(cleanData), lookback);
        const volumeStdDevValues = volumeStdDev.map((value) => value ?? 0);
        const volumeStdDevMedian = buildRollingMedian(volumeStdDevValues, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [average, atr, volumeStdDev, volumeStdDevMedian, pressure.pressureGap], (i) => {
            if (i < lookback * 2) return null;
            const center = average[i];
            const atrValue = atr[i];
            const dispersion = volumeStdDev[i];
            const dispersionMedian = volumeStdDevMedian[i];
            const pressureGap = pressure.pressureGap[i];
            if (
                center === null
                || atrValue === null
                || dispersion === null
                || dispersionMedian === null
                || pressureGap === null
            ) return null;

            const lowerBoundary = center - p.devMultiplier * atrValue;
            const upperBoundary = center + p.devMultiplier * atrValue;
            if (dispersion < dispersionMedian && typicals[i] < lowerBoundary && pressureGap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Low-dispersion downside exhaustion with YES pressure edge");
            }
            if (dispersion < dispersionMedian && typicals[i] > upperBoundary && pressureGap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "Low-dispersion upside exhaustion with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "devMultiplier", "minEdge"],
    },
};
