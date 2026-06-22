import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.1)),
	};
}

export const median_deviation_breakout_chase: Strategy = {
	name: "Median Deviation Breakout Chase",
	description: "Follows the breakout when the z-score of the deviation from the rolling median breaks out of its normal range, indicating a structural trend.",
	defaultParams: {
		lookback: 30,
		zThreshold: 2.1,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zThreshold: "Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const median = buildRollingMedian(closes, lookback);

		const deviation = new Array(closes.length).fill(0);
		for (let i = 0; i < closes.length; i++) {
			const m = median[i];
			deviation[i] = m !== null ? closes[i] - m : 0;
		}

		const deviationZ = buildRollingZScore(deviation, lookback);

		return createSignalLoop(cleanData, [deviationZ], (i) => {
			if (i < lookback * 2) return null;
			const dz = deviationZ[i];
			if (dz === null) return null;

			if (dz > zThreshold) {
				return createBuySignal(cleanData, i, `Median deviation breakout: z-score (${dz.toFixed(2)}) > ${zThreshold}`);
			}
			if (dz < -zThreshold) {
				return createSellSignal(cleanData, i, `Median deviation breakdown: z-score (${dz.toFixed(2)}) < -${zThreshold}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zThreshold"],
	},
};
