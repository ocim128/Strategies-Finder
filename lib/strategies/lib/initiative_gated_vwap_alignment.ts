import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

const INITIATIVE_GATED_VWAP_THRESHOLD = 0.5;

function normalizeInitiativeGatedVwapAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const initiative_gated_vwap_alignment: Strategy = {
    name: "Initiative Gated VWAP Alignment",
    description:
        "Uses signed initiative pressure to confirm active participation before taking close alignment with anchored VWAP.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeInitiativeGatedVwapAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativeGatedVwapAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const vwap = calculateVWAP(cleanData);

        return createSignalLoop(cleanData, [pressure, vwap], (i) => {
            const pressureValue = pressure[i];
            const valueAnchor = vwap[i];
            if (pressureValue === null || valueAnchor === null) return null;

            if (pressureValue > INITIATIVE_GATED_VWAP_THRESHOLD && closes[i] > valueAnchor) {
                return createBuySignal(cleanData, i, `Initiative-gated VWAP long pressure=${pressureValue.toFixed(2)}`);
            }
            if (pressureValue < -INITIATIVE_GATED_VWAP_THRESHOLD && closes[i] < valueAnchor) {
                return createSellSignal(cleanData, i, `Initiative-gated VWAP short pressure=${pressureValue.toFixed(2)}`);
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
