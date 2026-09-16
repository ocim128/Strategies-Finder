import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 26))),
    };
}

export const window_giveback_fib_double_touch_bounce: Strategy = {
    name: "Window Giveback Fib Double Touch Bounce",
    description: "Enters trend continuation off a micro double bottom formed in the 0.382-0.500 Fibonacci retracement zone.",
    defaultParams: {
        lookback: 26,
    },
    paramLabels: {
        lookback: "Excursion Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb, clsLoc], (i) => {
            if (i < Math.max(2, lookback)) return null;

            const gbNow = gb[i];
            const gbPrev2 = gb[i - 2];
            const cl = clsLoc[i];
            if (gbNow === null || gbPrev2 === null || cl === null) return null;

            const inFibZone = (val: number) => val >= 0.382 && val <= 0.50;
            if (!inFibZone(gbPrev2) || !inFibZone(gbNow)) return null;

            if (cl >= 0.75 && closes[i] > closes[i - lookback]) {
                return createBuySignal(cleanData, i, `Bullish Fib double touch: gb[i-2] ${gbPrev2.toFixed(3)}, gb[i] ${gbNow.toFixed(3)} in [0.382, 0.50], closeLocation ${cl.toFixed(2)} >= 0.75`);
            }
            if (cl <= 0.25 && closes[i] < closes[i - lookback]) {
                return createSellSignal(cleanData, i, `Bearish Fib double touch: gb[i-2] ${gbPrev2.toFixed(3)}, gb[i] ${gbNow.toFixed(3)} in [0.382, 0.50], closeLocation ${cl.toFixed(2)} <= 0.25`);
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
