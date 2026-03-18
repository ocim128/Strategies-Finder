import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingKurtosis } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

export const supertrend_kurtosis_anomaly: Strategy = {
	name: "Supertrend Kurtosis Anomaly",
	description: "Quantifies the absolute distance between price and the Supertrend line, identifying statistically extreme overextensions via rolling kurtosis to fade localized capitulations.",
	defaultParams: {
		stPeriod: 10,
		kurtosisLookback: 50,
		kurtosisThreshold: 3.5,
	},
	paramLabels: {
		stPeriod: "Supertrend Period",
		kurtosisLookback: "Kurtosis Lookback",
		kurtosisThreshold: "Kurtosis Threshold",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const stPeriod = Number(params.stPeriod ?? 10);
		const lookback = Number(params.kurtosisLookback ?? 50);
		const threshold = Number(params.kurtosisThreshold ?? 3.5);

		if (cleanData.length < Math.max(stPeriod * 2, lookback)) return [];

		const st = calculateSupertrend(
			cleanData.map(d => d.high),
			cleanData.map(d => d.low),
			cleanData.map(d => d.close),
			stPeriod,
			3.0
		);

		const absDistance = cleanData.map((d, i) => {
			if (st.supertrend[i] === null) return 0;
			return Math.abs(d.close - st.supertrend[i]!);
		});

		const kurtosis = buildRollingKurtosis(absDistance, lookback);
		const metrics = cleanData.map(d => getPriceActionBarMetrics(d));

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(stPeriod * 2, lookback) || kurtosis[i] === null || st.direction[i] === null || metrics[i].closeLocation === null) return null;

            const isBullishST = st.direction[i] === 1;
            const isBearishST = st.direction[i] === -1;
            const k = kurtosis[i]!;

            const closeLoc = metrics[i].closeLocation;

            if (isBullishST && k > threshold && closeLoc > 0.5) {
                return createBuySignal(cleanData, i, "Bullish Supertrend distance kurtosis spike with capitulation wick fade");
            }

            if (isBearishST && k > threshold && closeLoc < 0.5) {
                return createSellSignal(cleanData, i, "Bearish Supertrend distance kurtosis spike with rip fade");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stPeriod", "kurtosisLookback", "kurtosisThreshold"],
	},
};
