import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRollingMinMax } from "./price-action-statistics-core";

const PERSISTENCE_FLOOR = 0.05;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(5, Math.round(Number(params.period ?? 20))),
    };
}

export const cmf_persistent_accumulation: Strategy = {
    name: "CMF Persistent Accumulation",
    description: "Buys when the rolling minimum of CMF stays above a positive floor for a full window, and sells on the mirroring persistent distribution.",
    defaultParams: {
        period: 20,
    },
    paramLabels: {
        period: "CMF Period & Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.period as number;
        if (cleanData.length < period * 2) return [];

        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), getVolumes(cleanData), period);
        // Leading warm-up nulls are coerced; the warm-up guard keeps those bars
        // silent so the coerced zeros never certify a persistence state.
        const cmfNumbers = cmf.map((v) => (v === null ? 0 : v));
        const { min, max } = buildRollingMinMax(cmfNumbers, period);
        const firstValid = period * 2 - 2;

        return createSignalLoop(cleanData, [], (i) => {
            if (i < firstValid) return null;
            const minNow = min[i];
            const maxNow = max[i];
            const prevMin = min[i - 1];
            const prevMax = max[i - 1];
            if (minNow === null || maxNow === null || prevMin === null || prevMax === null) return null;

            // State entry: whole-window accumulation now certified, not before.
            if (minNow > PERSISTENCE_FLOOR && !(prevMin > PERSISTENCE_FLOOR)) {
                return createBuySignal(cleanData, i, `CMF accumulation buy: window min ${minNow.toFixed(3)} above floor`);
            }
            // State entry: whole-window distribution now certified, not before.
            if (maxNow < -PERSISTENCE_FLOOR && !(prevMax < -PERSISTENCE_FLOOR)) {
                return createSellSignal(cleanData, i, `CMF distribution sell: window max ${maxNow.toFixed(3)} below floor`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"],
    },
};
