import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeInitiativeCapitulationTrapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        pressure_lookback: Math.max(2, Math.round(params.pressure_lookback ?? 14)),
        pressure_z_extreme: Math.max(0, Number(params.pressure_z_extreme ?? 2.5)),
        rejection_loc: Math.max(0, Math.min(1, Number(params.rejection_loc ?? 0.2)))
    };
}

export const initiative_capitulation_trap: Strategy = {
    name: "Initiative Capitulation Trap",
    description: "When retail panics, they use market orders, creating massive initiative pressure. If the bar's close location rejects this pressure, limit orders fully absorbed the panic.",
    defaultParams: {
        pressure_lookback: 14,
        pressure_z_extreme: 2.5,
        rejection_loc: 0.2
    },
    paramLabels: {
        pressure_lookback: "Pressure Lookback",
        pressure_z_extreme: "Pressure Z-Score Extreme",
        rejection_loc: "Rejection Close Location"
    },
    normalizeParams: normalizeInitiativeCapitulationTrapParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativeCapitulationTrapParams(params);
        if (cleanData.length < (p.pressure_lookback as number) * 2) return [];

        const pressure = buildInitiativePressureSeries(cleanData, p.pressure_lookback as number);
        const pressureArray = pressure.map(x => x ?? 0);
        const pressureZScore = buildRollingZScore(pressureArray, p.pressure_lookback as number);
        const closeLocSeries = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [pressureZScore], (i) => {
            if (i < (p.pressure_lookback as number)) return null;
            const pZ = pressureZScore[i];
            if (pZ === null) return null;

            const closeLoc = closeLocSeries[i];
            const extreme = p.pressure_z_extreme as number;
            const rejLoc = p.rejection_loc as number;

            if (pZ < -extreme && closeLoc > (1.0 - rejLoc)) {
                return createBuySignal(cleanData, i, `Negative pressure Z < ${-extreme} rejected at closeLoc > ${1.0 - rejLoc}`);
            }
            if (pZ > extreme && closeLoc < rejLoc) {
                return createSellSignal(cleanData, i, `Positive pressure Z > ${extreme} rejected at closeLoc < ${rejLoc}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["pressure_lookback", "pressure_z_extreme", "rejection_loc"]
    }
};
