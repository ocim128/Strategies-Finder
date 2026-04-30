import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow, clamp } from "./price-action-frequency-core";

function normalizeTrailingSpanZoneAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        zone_edge: Math.max(0.5, Math.min(0.99, Number(params.zone_edge ?? 0.65))),
    };
}

export const trailing_span_zone_acceptance: Strategy = {
    name: "Trailing Span Zone Acceptance",
    description:
        "Locates the completed close inside a trailing high-low auction envelope and enters only when settlement is already accepted in the upper or lower zone of that structure.",
    defaultParams: {
        lookback: 63,
        zone_edge: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        zone_edge: "Zone Edge",
    },
    normalizeParams: normalizeTrailingSpanZoneAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingSpanZoneAcceptanceParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            if (i < lookback) return null;

            const hi = highest[i];
            const lo = lowest[i];
            if (hi === null || lo === null || hi <= lo) return null;

            const position = clamp((closes[i] - lo) / (hi - lo), 0, 1);
            if (position > (p.zone_edge as number)) {
                return createBuySignal(cleanData, i, `Close accepted in upper span zone (${position.toFixed(2)})`);
            }
            if (position < 1 - (p.zone_edge as number)) {
                return createSellSignal(cleanData, i, `Close accepted in lower span zone (${position.toFixed(2)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zone_edge"],
    },
};
