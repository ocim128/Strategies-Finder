import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.05),
	};
}

export const quarter_kelly_streak_exhaustion_fade: Strategy = {
	name: "Quarter Kelly Streak Exhaustion Fade",
	description: "Fades price deviations when win rates scaled to return streak lengths yield a positive Quarter-Kelly allocation.",
	defaultParams: {
		lookback: 50,
		minQuarterKelly: 0.05,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minQuarterKelly = p.minQuarterKelly as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const flags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const ret = returns[j];
			flags[j] = ret > 0 ? 1 : (ret < 0 ? -1 : 0);
		}
		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			const sc = streaks[i];
			if (sc === 0) return null;

			const absStreak = Math.abs(sc);
			const winProb = 0.5 + absStreak * 0.07;
			const qKelly = 0.25 * (2 * winProb - 1);

			if (qKelly > minQuarterKelly) {
				if (z < -1.5 && sc < 0) {
					return createBuySignal(cleanData, i, `Streak exhaustion fade buy: Z ${z.toFixed(2)}, Streak ${sc}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
				if (z > 1.5 && sc > 0) {
					return createSellSignal(cleanData, i, `Streak exhaustion fade sell: Z ${z.toFixed(2)}, Streak ${sc}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_streak_exhaustion_fade.executePrepared!(
			quarter_kelly_streak_exhaustion_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
