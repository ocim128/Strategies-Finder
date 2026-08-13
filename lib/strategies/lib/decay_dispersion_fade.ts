import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

const STRETCH_THRESHOLD = 2.0;
const MIN_DECAY_STD = 1e-9;
const WARMUP_BARS = 30;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.min(0.999, Math.max(0.5, Number(params.decay ?? 0.95))),
    };
}

export const decay_dispersion_fade: Strategy = {
    name: "Decay Dispersion Fade",
    description: "Fades stretch measured in decay-weighted standard deviations around a decay-weighted fair center.",
    defaultParams: {
        decay: 0.95,
    },
    paramLabels: {
        decay: "Decay Retention",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const decay = normalizeParams(params).decay as number;
        if (cleanData.length < WARMUP_BARS + 1) return [];

        const closes = getCloses(cleanData);
        const ones = closes.map(() => 1);
        const closeSquared = closes.map((v) => v * v);
        const denom = buildCumulativeDecaySum(ones, decay);
        const weightedClose = buildCumulativeDecaySum(closes, decay);
        const weightedCloseSquared = buildCumulativeDecaySum(closeSquared, decay);

        // Stretch in decay-weighted standard deviations, positive when close sits
        // below the decay-weighted center. NaN during the fixed warm-up.
        const stretch = new Array<number>(cleanData.length).fill(NaN);
        for (let i = 0; i < cleanData.length; i++) {
            if (i < WARMUP_BARS) continue;
            const center = weightedClose[i] / denom[i];
            const variance = Math.max(0, weightedCloseSquared[i] / denom[i] - center * center);
            const std = Math.max(MIN_DECAY_STD, Math.sqrt(variance));
            stretch[i] = (center - closes[i]) / std;
        }

        return createSignalLoop(cleanData, [], (i) => {
            const z = stretch[i];
            if (!Number.isFinite(z)) return null;

            if (z >= STRETCH_THRESHOLD) {
                return createBuySignal(cleanData, i, `Stretch ${z.toFixed(2)} decay-std below center`);
            }
            if (z <= -STRETCH_THRESHOLD) {
                return createSellSignal(cleanData, i, `Stretch ${(-z).toFixed(2)} decay-std above center`);
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
