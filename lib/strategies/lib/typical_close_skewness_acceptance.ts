import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        minSkew: Number(params.minSkew ?? 0.2),
    };
}

export const typical_close_skewness_acceptance: Strategy = {
    name: "Typical Close Skewness Acceptance",
    description: "Enters when typical price returns display asymmetry (skewness) and close acceptance agrees.",
    defaultParams: {
        lookback: 40,
        minSkew: 0.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minSkew: "Min Skew",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const typicalMom1 = buildRateOfChange(typical, 1);
        const typicalReturns = typicalMom1.map((v) => v ?? 0);

        const skew = buildRollingSkewness(typicalReturns, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [skew, acceptance], (i) => {
            if (i < lookback) return null;
            const currentSkew = skew[i];
            const currentAccept = acceptance[i];
            if (currentSkew === null || currentAccept === null) return null;

            const threshold = p.minSkew as number;

            // Buy: typical return skewness > minSkew, close acceptance > 0
            if (currentSkew > threshold && currentAccept > 0) {
                return createBuySignal(cleanData, i, `Typical Skew Acceptance Buy: Skew ${currentSkew.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }
            // Sell: typical return skewness < -minSkew, close acceptance < 0
            if (currentSkew < -threshold && currentAccept < 0) {
                return createSellSignal(cleanData, i, `Typical Skew Acceptance Sell: Skew ${currentSkew.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minSkew"],
    },
};
