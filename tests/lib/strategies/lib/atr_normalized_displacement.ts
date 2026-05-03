import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";

function normalizeAtrNormalizedDisplacementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        displacement_bars: Math.max(1, Math.round(Number(params.displacement_bars ?? 5))),
        threshold: Math.max(0, Number(params.threshold ?? 1.5)),
    };
}

export const atr_normalized_displacement: Strategy = {
    name: "ATR Normalized Displacement",
    description:
        "Signals multi-bar close displacement only when the move is large enough relative to contemporaneous ATR.",
    defaultParams: {
        displacement_bars: 5,
        threshold: 1.5,
    },
    paramLabels: {
        displacement_bars: "Displacement Bars",
        threshold: "Threshold",
    },
    normalizeParams: normalizeAtrNormalizedDisplacementParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAtrNormalizedDisplacementParams(params);
        const bars = p.displacement_bars as number;
        const threshold = p.threshold as number;
        const atrPeriod = Math.max(14, bars * 3);
        if (cleanData.length < atrPeriod + bars) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, atrPeriod);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < bars) return null;

            const currentAtr = atr[i];
            if (currentAtr === null || currentAtr <= 0) return null;

            const displacement = closes[i] - closes[i - bars];
            const normalized = displacement / currentAtr;
            if (normalized > threshold) {
                return createBuySignal(cleanData, i, `ATR-normalized upside displacement ${normalized.toFixed(2)}`);
            }
            if (normalized < -threshold) {
                return createSellSignal(cleanData, i, `ATR-normalized downside displacement ${normalized.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["displacement_bars", "threshold"],
    },
};
