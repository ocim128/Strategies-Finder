import { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { calculateParabolicSAR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";

const MAXIMUM_ACCELERATION = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        accelerationStep: Math.min(
            MAXIMUM_ACCELERATION,
            Math.max(0.001, Number(params.accelerationStep ?? 0.02))
        ),
    };
}

export const parabolic_sar_confirmation: Strategy = {
    name: "Parabolic SAR Confirmation",
    description: "Signals when Parabolic SAR flips direction, using a fixed maximum acceleration of 0.20.",
    defaultParams: {
        accelerationStep: 0.02,
    },
    paramLabels: {
        accelerationStep: "Acceleration Step",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        if (cleanData.length < 3) return [];

        const sar = calculateParabolicSAR(
            getHighs(cleanData),
            getLows(cleanData),
            getCloses(cleanData),
            p.accelerationStep as number,
            MAXIMUM_ACCELERATION
        );
        return createSignalLoop(cleanData, [sar.sar, sar.direction], (i) => {
            if (sar.direction[i - 1] === -1 && sar.direction[i] === 1) {
                return createBuySignal(cleanData, i, "Parabolic SAR flipped bullish");
            }
            if (sar.direction[i - 1] === 1 && sar.direction[i] === -1) {
                return createSellSignal(cleanData, i, "Parabolic SAR flipped bearish");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["accelerationStep"],
    },
};
