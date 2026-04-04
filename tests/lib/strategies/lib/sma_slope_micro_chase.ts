import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateSMA } from "../indicators";

export const sma_slope_micro_chase: Strategy = {
	name: "SMA Slope Micro Chase",
	description: "Enter in the direction of the SMA slope.",
	defaultParams: {
		smaPeriod: 5,
	},
	paramLabels: {
		smaPeriod: "SMA Period",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const closes = getCloses(cleanData);
		const smaPeriod = Number(params.smaPeriod ?? 5);

		if (cleanData.length < smaPeriod * 2) return [];

		const sma = calculateSMA(closes, smaPeriod);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || sma[i] === null || sma[i-1] === null) return null;

			if (sma[i]! > sma[i-1]!) {
				return createBuySignal(cleanData, i, "SMA slope bullish");
			} else if (sma[i]! < sma[i-1]!) {
				return createSellSignal(cleanData, i, "SMA slope bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["smaPeriod"],
	},
};
