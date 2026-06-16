import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseAcceptanceSeries,
    buildCloseLocationSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        acceptanceLevel: Math.max(0.5, Math.min(1.0, Number(params.acceptanceLevel ?? 0.6))),
    };
}

export const acceptance_pressure_direction: Strategy = {
    name: "Acceptance Pressure Direction",
    description: "Fades persistent close acceptance pressure when a current bar closes at the opposite extreme.",
    defaultParams: {
        lookback: 20,
        acceptanceLevel: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acceptanceLevel: "Acceptance Level",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        // Map acceptance from [-1, 1] to [0, 1] to match parameter expectations
        const mapped = acceptance.map((v) => (v + 1) / 2);
        const smoothedAcceptance = buildRollingAverage(mapped, lookback);

        return createSignalLoop(cleanData, [smoothedAcceptance], (i) => {
            const acc = smoothedAcceptance[i];
            if (acc === null) return null;

            const cl = closeLocation[i];

            // Buy: persistent top-side acceptance but current bar closes low (breaking dominance)
            if (acc > p.acceptanceLevel && cl < 0.3) {
                return createBuySignal(cleanData, i, `Acceptance pressure buy: rolling acceptance ${acc.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }
            // Sell: persistent bottom-side acceptance but current bar closes high (breaking dominance)
            if (acc < (1 - p.acceptanceLevel) && cl > 0.7) {
                return createSellSignal(cleanData, i, `Acceptance pressure sell: rolling acceptance ${acc.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acceptanceLevel"],
    },
};
