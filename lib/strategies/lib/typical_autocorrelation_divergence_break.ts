import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minAutoCorr: Number(params.minAutoCorr ?? 0.25),
    };
}

export const typical_autocorrelation_divergence_break: Strategy = {
    name: "Typical Autocorrelation Divergence Break",
    description: "Enters trends when typical price returns show serial persistence and typical price momentum leads close momentum.",
    defaultParams: {
        lookback: 30,
        minAutoCorr: 0.25,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minAutoCorr: "Min Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);
        const typicalMom1 = buildRateOfChange(typical, 1);
        const typicalReturns = typicalMom1.map((v) => v ?? 0);

        const ac = buildRollingAutoCorrelation(typicalReturns, lookback, 1);
        const typicalMom = buildRateOfChange(typical, lookback);
        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [ac, typicalMom, closeMom], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentTypMom = typicalMom[i];
            const currentCloseMom = closeMom[i];
            if (currentAc === null || currentTypMom === null || currentCloseMom === null) return null;

            const minAc = p.minAutoCorr as number;

            // Buy: autocorrelation > minAutoCorr, typical price momentum > 0, close momentum < typical price momentum
            if (currentAc > minAc && currentTypMom > 0 && currentCloseMom < currentTypMom) {
                return createBuySignal(cleanData, i, `Typical Auto Break Buy: AC ${currentAc.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }
            // Sell: autocorrelation > minAutoCorr, typical price momentum < 0, close momentum > typical price momentum
            if (currentAc > minAc && currentTypMom < 0 && currentCloseMom > currentTypMom) {
                return createSellSignal(cleanData, i, `Typical Auto Break Sell: AC ${currentAc.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAutoCorr"],
    },
};
