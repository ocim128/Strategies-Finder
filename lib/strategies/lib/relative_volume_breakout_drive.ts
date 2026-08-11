import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const VOLUME_SURGE = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const relative_volume_breakout_drive: Strategy = {
    name: "Relative Volume Breakout Drive",
    description: "Buys a fresh close beyond the prior-only trailing high when it rides a relative volume surge, and sells the mirror.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Breakout & Volume Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const volumeZ = buildRollingZScore(volumes, lookback);

        return createSignalLoop(cleanData, [highest, lowest, volumeZ], (i) => {
            const hi = highest[i];
            const lo = lowest[i];
            const hiPrev = highest[i - 1];
            const loPrev = lowest[i - 1];
            const z = volumeZ[i];
            if (hi === null || lo === null || hiPrev === null || loPrev === null || z === null) return null;

            // Fresh breakout (previous close still inside the prior-only channel)
            // confirmed by a relative-volume surge.
            if (closes[i] > hi && closes[i - 1] <= hiPrev && z >= VOLUME_SURGE) {
                return createBuySignal(cleanData, i, `Volume breakout buy: close ${closes[i].toFixed(4)} > trailing high ${hi.toFixed(4)} on volume z ${z.toFixed(2)}`);
            }
            if (closes[i] < lo && closes[i - 1] >= loPrev && z >= VOLUME_SURGE) {
                return createSellSignal(cleanData, i, `Volume breakout sell: close ${closes[i].toFixed(4)} < trailing low ${lo.toFixed(4)} on volume z ${z.toFixed(2)}`);
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
