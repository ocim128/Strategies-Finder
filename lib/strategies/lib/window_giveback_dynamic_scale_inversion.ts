import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRangeSeries,
    buildRollingAverage,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        parabolic_giveback_max: Math.max(0.01, Math.min(0.5, Number(params.parabolic_giveback_max ?? 0.15))),
    };
}

export const window_giveback_dynamic_scale_inversion: Strategy = {
    name: "Window Giveback Dynamic Scale Inversion",
    description: "Dynamically scales giveback tolerance based on normalized excursion amplitude.",
    defaultParams: {
        parabolic_giveback_max: 0.15,
    },
    paramLabels: {
        parabolic_giveback_max: "Parabolic Giveback Max",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const parabolicMax = Number(params.parabolic_giveback_max);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, 20);
        const ranges = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(ranges, 20);

        return createSignalLoop(cleanData, [gb, avgRange], (i) => {
            if (i < 20) return null;
            const g = gb[i];
            const ar = avgRange[i];
            if (g === null || ar === null) return null;

            const netMoveUp = closes[i] - closes[i - 20];
            if (netMoveUp > 0 && cleanData[i].close > cleanData[i].open) {
                const isParabolic = netMoveUp > 2 * ar;
                if ((isParabolic && g <= parabolicMax) || (!isParabolic && g <= 0.50)) {
                    return createBuySignal(cleanData, i, `Bullish dynamic scale inversion: ${isParabolic ? "parabolic" : "normal"} move, giveback=${g.toFixed(2)}`);
                }
            }

            const netMoveDown = closes[i - 20] - closes[i];
            if (netMoveDown > 0 && cleanData[i].close < cleanData[i].open) {
                const isParabolic = netMoveDown > 2 * ar;
                if ((isParabolic && g <= parabolicMax) || (!isParabolic && g <= 0.50)) {
                    return createSellSignal(cleanData, i, `Bearish dynamic scale inversion: ${isParabolic ? "parabolic" : "normal"} move, giveback=${g.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["parabolic_giveback_max"],
    },
};
