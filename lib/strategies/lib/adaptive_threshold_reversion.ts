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
import { buildCumulativeDecaySum, buildRollingAutoCorrelation } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const AUTOCORR_WINDOW = 30;
const BASE_THRESHOLD = 0.8;
const THRESHOLD_SPAN = 2.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.min(0.999, Math.max(0.5, Number(params.decay ?? 0.95))),
    };
}

export const adaptive_threshold_reversion: Strategy = {
    name: "Adaptive Threshold Reversion",
    description: "Fades closes stretched beyond an ATR band whose width adapts to the estimated mean-reversion speed of the deviation series.",
    defaultParams: {
        decay: 0.95,
    },
    paramLabels: {
        decay: "Decay Factor",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const decay = p.decay as number;
        if (cleanData.length < ATR_PERIOD) return [];

        const closes = getCloses(cleanData);
        const decayCloses = buildCumulativeDecaySum(closes, decay);
        const ones = new Array<number>(cleanData.length).fill(1);
        const decayOnes = buildCumulativeDecaySum(ones, decay);
        const center: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            center[i] = decayOnes[i] > 0 ? decayCloses[i] / decayOnes[i] : 0;
        }

        const deviation: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            deviation[i] = center[i] - closes[i];
        }
        const acDev = buildRollingAutoCorrelation(deviation, AUTOCORR_WINDOW, 1);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        return createSignalLoop(cleanData, [atr, acDev], (i) => {
            const a = atr[i];
            const ac = acDev[i];
            if (a === null || a <= 0) return null;
            if (ac === null || Number.isNaN(ac)) return null;

            // thr ranges 0.8 (acDev = -1: instant reversion, tight band) to
            // 3.2 (acDev >= 0: persistent, nearly no fades).
            const thr = BASE_THRESHOLD + THRESHOLD_SPAN * (1 - Math.max(0, -ac));
            // stretch = (decay center - close) / ATR; positive means price sits
            // below the decay-weighted fair center.
            const stretch = (center[i] - closes[i]) / a;
            if (stretch >= thr) {
                return createBuySignal(cleanData, i, `Decay stretch ${stretch.toFixed(2)} ATR below center, adaptive band ${thr.toFixed(2)}`);
            }
            if (stretch <= -thr) {
                return createSellSignal(cleanData, i, `Decay stretch ${(-stretch).toFixed(2)} ATR above center, adaptive band ${thr.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay"],
    },
};
