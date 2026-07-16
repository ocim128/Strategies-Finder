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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.08),
	};
}

export const quarter_kelly_efficiency_gated_fade: Strategy = {
	name: "Quarter Kelly Efficiency Gated Fade",
	description: "Fades price z-score deviations when Quarter-Kelly WinRate (1 - Efficiency) exceeds minQuarterKelly.",
	defaultParams: {
		lookback: 30,
		minQuarterKelly: 0.08,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
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
		const minQuarterKelly = p.minQuarterKelly as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

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
			const efficiency = er[i];
			if (z === null || efficiency === null) return null;

			const winProb = 1 - efficiency;
			const qKelly = 0.25 * (2 * winProb - 1);

			if (qKelly > minQuarterKelly) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Efficiency fade buy: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Efficiency fade sell: Z ${z.toFixed(2)}, ER ${efficiency.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_efficiency_gated_fade.executePrepared!(
			quarter_kelly_efficiency_gated_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
