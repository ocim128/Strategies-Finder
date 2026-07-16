import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	checkCrossover,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	erByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
		efficiencyTrigger: Number(params.efficiencyTrigger ?? 0.4),
	};
}

export const efficiency_exhaustion_center_snap: Strategy = {
	name: "Efficiency Exhaustion Center Snap",
	description: "Fades price extremes (Z-score 2.0) when efficiency ratio crosses below the efficiencyTrigger threshold.",
	defaultParams: {
		lookback: 25,
		efficiencyTrigger: 0.4,
	},
	paramLabels: {
		lookback: "Lookback Window",
		efficiencyTrigger: "Efficiency Trigger",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		erByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const efficiencyTrigger = p.efficiencyTrigger as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const erByLookback = prepared?.erByLookback ?? new Map<number, (number | null)[]>();
		let er = erByLookback.get(lookback);
		if (!er) {
			er = buildEfficiencyRatio(cleanData, lookback);
			erByLookback.set(lookback, er);
		}

		const thresholdArray = new Array(len).fill(efficiencyTrigger);

		return createSignalLoop(cleanData, [zscore, er], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Check if efficiency ratio crosses below the trigger
			const cross = checkCrossover(er, thresholdArray, i);

			if (cross === "bearish") {
				if (z < -2.0) {
					return createBuySignal(cleanData, i, `Efficiency breakdown buy: Z ${z.toFixed(2)}, ER crossed below ${efficiencyTrigger}`);
				}
				if (z > 2.0) {
					return createSellSignal(cleanData, i, `Efficiency breakdown sell: Z ${z.toFixed(2)}, ER crossed below ${efficiencyTrigger}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		efficiency_exhaustion_center_snap.executePrepared!(
			efficiency_exhaustion_center_snap.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "efficiencyTrigger"],
	},
};
