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
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const ANCHOR_DISTANCE_ATR = 2;
const FIXED_DECAY = 1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: FIXED_DECAY,
    };
}

export const decay_anchor_reversion: Strategy = {
    name: "Decay Anchor Reversion",
    description: "Fades closes stretched at least 2 ATR from a cumulative fair center.",
    defaultParams: {
        decay: 1,
    },
    paramLabels: {
        decay: "Decay Factor",
    },
    finderFixedParams: ["decay"],
    normalizeParams,
    execute: (data: OHLCVData[], _params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const decay = FIXED_DECAY;
        if (cleanData.length < ATR_PERIOD) return [];

        const closes = getCloses(cleanData);
        const decayCloses = buildCumulativeDecaySum(closes, decay);
        // The ones-series normalization makes the weighted center unbiased from bar zero.
        const ones = new Array<number>(cleanData.length).fill(1);
        const decayOnes = buildCumulativeDecaySum(ones, decay);
        const center = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            center[i] = decayOnes[i] > 0 ? decayCloses[i] / decayOnes[i] : 0;
        }

        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        return createSignalLoop(cleanData, [atr], (i) => {
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) return null;

            const stretchDown = (center[i] - closes[i]) / atrNow;
            if (stretchDown >= ANCHOR_DISTANCE_ATR) {
                return createBuySignal(cleanData, i, `Decay anchor buy: close ${stretchDown.toFixed(2)} ATR below decay center`);
            }
            const stretchUp = (closes[i] - center[i]) / atrNow;
            if (stretchUp >= ANCHOR_DISTANCE_ATR) {
                return createSellSignal(cleanData, i, `Decay anchor sell: close ${stretchUp.toFixed(2)} ATR above decay center`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: [],
    },
};
