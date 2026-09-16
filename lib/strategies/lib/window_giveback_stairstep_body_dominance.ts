import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildBodyPctSeries,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 25))),
    };
}

export const window_giveback_stairstep_body_dominance: Strategy = {
    name: "Window Giveback Stairstep Body Dominance",
    description: "Enters stair-step trend resumption when shallow 0.30 to 0.382 giveback is confirmed by candle body dominance.",
    defaultParams: {
        lookback: 25,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [gb, bodyPct], (i) => {
            if (i < lookback) return null;
            const g = gb[i];
            const bp = bodyPct[i];
            if (g === null || bp === null) return null;

            if (g >= 0.30 && g <= 0.382 && bp >= 0.60) {
                if (closes[i] > closes[i - lookback] && cleanData[i].close > cleanData[i].open) {
                    return createBuySignal(cleanData, i, `Bullish stairstep body dominance: giveback=${g.toFixed(3)} in [0.30,0.382], bodyPct=${(bp * 100).toFixed(0)}%>=60%`);
                }
                if (closes[i] < closes[i - lookback] && cleanData[i].close < cleanData[i].open) {
                    return createSellSignal(cleanData, i, `Bearish stairstep body dominance: giveback=${g.toFixed(3)} in [0.30,0.382], bodyPct=${(bp * 100).toFixed(0)}%>=60%`);
                }
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
