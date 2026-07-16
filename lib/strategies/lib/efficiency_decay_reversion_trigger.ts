import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
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
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 24))),
		efficiencyDrop: Number(params.efficiencyDrop ?? 0.25),
	};
}

export const efficiency_decay_reversion_trigger: Strategy = {
	name: "Efficiency Decay Reversion Trigger",
	description: "Fades price extremes when efficiency ratio decays significantly (efficiencyDrop over 5 bars) from its rolling peak.",
	defaultParams: {
		lookback: 24,
		efficiencyDrop: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		efficiencyDrop: "Efficiency Drop",
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
		const efficiencyDrop = p.efficiencyDrop as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 5) return [];

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

		return createSignalLoop(cleanData, [zscore, er], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const currentEr = er[i];
			if (z === null || currentEr === null) return null;

			// Find max efficiency in the last 5 bars [i - 4, i]
			let maxEr = -1;
			for (let k = i - 4; k <= i; k++) {
				const val = er[k];
				if (val !== null && val > maxEr) {
					maxEr = val;
				}
			}

			if (maxEr !== -1 && (maxEr - currentEr) >= efficiencyDrop) {
				if (z < -1.8) {
					return createBuySignal(cleanData, i, `Efficiency decay buy: Z ${z.toFixed(2)}, max ER ${maxEr.toFixed(2)} -> current ${currentEr.toFixed(2)}`);
				}
				if (z > 1.8) {
					return createSellSignal(cleanData, i, `Efficiency decay sell: Z ${z.toFixed(2)}, max ER ${maxEr.toFixed(2)} -> current ${currentEr.toFixed(2)}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		efficiency_decay_reversion_trigger.executePrepared!(
			efficiency_decay_reversion_trigger.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "efficiencyDrop"],
	},
};
