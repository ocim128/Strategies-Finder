import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateSessionVWAP } from "../indicators";

function normalizeSessionVwapAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        distance_pct: Math.max(0, Number(params.distance_pct ?? 0.0)),
    };
}

export const session_vwap_anchor: Strategy = {
    name: "Session VWAP Anchor",
    description: "Session VWAP resets at each session boundary and represents the current session's volume-weighted consensus value. Closes above it imply session flow is accepting higher prices; closes below imply the opposite.",
    defaultParams: {
        distance_pct: 0.0,
    },
    paramLabels: {
        distance_pct: "Distance %",
    },
    normalizeParams: normalizeSessionVwapAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSessionVwapAnchorParams(params);
        if (cleanData.length < 2) return [];

        const closes = getCloses(cleanData);
        const sessionVwap = calculateSessionVWAP(cleanData);
        const distancePct = p.distance_pct as number;
        const minRatio = distancePct / 100;

        return createSignalLoop(cleanData, [sessionVwap], (i) => {
            const vwap = sessionVwap[i];
            if (vwap === null || vwap === 0) return null;

            const diffRatio = (closes[i] - vwap) / vwap;
            if (diffRatio > minRatio) {
                return createBuySignal(cleanData, i, `Close ${(diffRatio * 100).toFixed(2)}% above session VWAP`);
            }
            if (diffRatio < -minRatio) {
                return createSellSignal(cleanData, i, `Close ${Math.abs(diffRatio * 100).toFixed(2)}% below session VWAP`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["distance_pct"],
    },
};
