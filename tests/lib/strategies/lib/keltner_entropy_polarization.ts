import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import { buildRollingEntropy } from "./price-action-statistics-core";

export const keltner_entropy_polarization: Strategy = {
    name: "Keltner Entropy Polarization",
    description: "A macroscopic regime algorithm that requires price to run continuously outside Keltner limits while simultaneously measuring ultra-low Shannon Entropy, proving the massive deviation is a smooth institutional flow, not chaotic volatility.",
    defaultParams: {
        keltnerPeriod: 20,
        keltnerMult: 2.0,
        entropyCeiling: 0.6,
    },
    paramLabels: {
        keltnerPeriod: "Keltner Center Channel Flow",
        keltnerMult: "Volatility Excursion Ceiling",
        entropyCeiling: "Required Structural Regime Silence",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const kPeriod = params.keltnerPeriod as number;

        if (cleanData.length < kPeriod + 30) return [];

        const keltner = calculateKeltnerChannels(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            kPeriod,
            kPeriod,
            params.keltnerMult as number
        );

        const returns = cleanData.map((d, i) => i === 0 ? 0 : (d.close - cleanData[i - 1].close) / (cleanData[i - 1].close || 1));
        const safeReturns = returns.map(v => v === 0 ? 0.000001 : v);
        const entropy = buildRollingEntropy(safeReturns, 30); // Hardcoded 30 internally as per impl notes

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 32 || keltner.upper[i] === null || keltner.lower[i] === null || entropy[i] === null) return null;

            const currClose = cleanData[i].close;
            const isBullish = cleanData[i].close > cleanData[i].open;
            const isBearish = cleanData[i].close < cleanData[i].open;
            const currentEntropy = entropy[i]!;

            const entropyLock = params.entropyCeiling as number;

            // Trend escapes envelope, entropy is extremely low proving institutional ordering
            if (currClose > keltner.upper[i]! && currentEntropy < entropyLock && isBullish) {
                return createBuySignal(cleanData, i, "Macroscopic expansion deeply outside Keltner boundaries validated by total informational entropy collapse");
            }

            if (currClose < keltner.lower[i]! && currentEntropy < entropyLock && isBearish) {
                return createSellSignal(cleanData, i, "Macroscopic plunge deeply outside Keltner boundaries validated by total informational entropy collapse");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["keltnerPeriod", "keltnerMult", "entropyCeiling"],
    },
};
