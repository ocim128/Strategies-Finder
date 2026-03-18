import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateMomentum } from "../indicators";
import { buildRollingEntropy, buildRollingCorrelation } from "./price-action-statistics-core";

export const momentum_entropy_correlation_shift: Strategy = {
	name: "Momentum Entropy Correlation Shift",
	description: "Evaluates macro regimes entirely via the mathematical Pearson Correlation between underlying price and an absolute Momentum indicator.",
	defaultParams: {
		momPeriod: 14,
		corrLookback: 30,
		entropyMinimum: 1.5,
	},
	paramLabels: {
		momPeriod: "Momentum Period",
		corrLookback: "Correlation Lookback",
		entropyMinimum: "Entropy Minimum",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const momLen = Number(params.momPeriod ?? 14);
		const lookback = Number(params.corrLookback ?? 30);
		const entMin = Number(params.entropyMinimum ?? 1.5);

		if (cleanData.length < Math.max(momLen, lookback)) return [];

		const momentum = calculateMomentum(cleanData.map(d => d.close), momLen);
		
		const closes = cleanData.map(d => d.close);
		const cleanMom = momentum.map(m => m === null ? 0 : m);
		const corr = buildRollingCorrelation(closes, cleanMom, lookback);
		const entropy = buildRollingEntropy(closes, lookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(momLen, lookback) || entropy[i] === null || corr[i] === null) return null;

            let wasNegative = false;
            for (let j = 1; j <= 5; j++) {
                if (i - j >= 0 && corr[i-j] !== null && corr[i-j]! < 0) {
                    wasNegative = true;
                    break;
                }
            }

            if (entropy[i]! > entMin && wasNegative && corr[i]! > 0.75) {
                if (cleanData[i].close > cleanData[i-1].close) {
                    return createBuySignal(cleanData, i, "Positive correlation synchronization restoration (Bullish)");
                } else if (cleanData[i].close < cleanData[i-1].close) {
                    return createSellSignal(cleanData, i, "Positive correlation synchronization restoration (Bearish)");
                }
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["momPeriod", "corrLookback", "entropyMinimum"],
	},
};
