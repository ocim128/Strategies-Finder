import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

export const crossing_churn_suppression: Strategy = {
	name: "Crossing Churn Suppression",
	description: "Identifies low-churn directional regimes by requiring that price stays on one side of a rolling average with minimal crossing events.",
	defaultParams: {
		maPeriod: 20,
		maxCrossings: 2,
	},
	paramLabels: {
		maPeriod: "MA Period",
		maxCrossings: "Max Crossings",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < params.maPeriod * 2) return [];

		const closes = getCloses(cleanData);
		const maArrays = buildRollingAverage(closes, params.maPeriod);

		const maDiffs = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const ma = maArrays[i];
			if (ma === null) continue;
			maDiffs[i] = closes[i] - ma;
		}

		// Use maPeriod as the lookback window for crossing count
		const crossingArrays = buildThresholdCrossingCount(maDiffs, params.maPeriod, 0);

		return createSignalLoop(cleanData, [maArrays, crossingArrays], (i) => {
			const currentDiff = maDiffs[i];
			const crossings = crossingArrays[i];
			const ma = maArrays[i];

			if (crossings === null || ma === null || i < params.maPeriod) return null;

			// Ensure that over the lookback, price was mostly on one side by checking current side + low crossings
			if (crossings <= params.maxCrossings) {
				if (currentDiff > 0 && closes[i-1] > maArrays[i-1]!) {
					// We verify that currently we are above MA and have low crossings
					return createBuySignal(cleanData, i, `Bullish Churn Suppression (Crosses: ${crossings})`);
				}
				if (currentDiff < 0 && closes[i-1] < maArrays[i-1]!) {
					// We verify that currently we are below MA and have low crossings
					return createSellSignal(cleanData, i, `Bearish Churn Suppression (Crosses: ${crossings})`);
				}
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["maPeriod", "maxCrossings"],
	},
};
