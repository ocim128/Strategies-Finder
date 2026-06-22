import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		zScoreThreshold: Math.max(0.1, Number(params.zScoreThreshold ?? 2.0)),
	};
}

export const median_deviation_zscore_reversion: Strategy = {
	name: "Median Deviation Z-Score Reversion",
	description: "Fades extreme ratio deviations from the rolling median measured in rolling standard deviations.",
	defaultParams: {
		lookback: 30,
		zScoreThreshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zScoreThreshold: "Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const zScoreThreshold = p.zScoreThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);

		const distance = new Array(closes.length).fill(0);
		for (let i = 0; i < closes.length; i++) {
			const m = median[i];
			distance[i] = m !== null ? closes[i] - m : 0;
		}

		const stddev = buildRollingStdDev(distance, lookback);

		return createSignalLoop(cleanData, [stddev], (i) => {
			if (i < lookback * 2) return null;
			const sd = stddev[i];
			if (sd === null || sd === 0) return null;

			const z = distance[i] / sd;

			if (z <= -zScoreThreshold) {
				return createBuySignal(cleanData, i, `Distance z-score ${z.toFixed(2)} <= -${zScoreThreshold}`);
			}
			if (z >= zScoreThreshold) {
				return createSellSignal(cleanData, i, `Distance z-score ${z.toFixed(2)} >= ${zScoreThreshold}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zScoreThreshold"],
	},
};
