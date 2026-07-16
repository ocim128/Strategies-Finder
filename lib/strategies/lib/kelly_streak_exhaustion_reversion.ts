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
		minKellyFraction: Number(params.minKellyFraction ?? 0.2),
	};
}

export const kelly_streak_exhaustion_reversion: Strategy = {
	name: "Kelly Streak Exhaustion Reversion",
	description: "Fades directional close return streaks when win probability scaled to streak length yields a positive Kelly allocation above minKellyFraction.",
	defaultParams: {
		lookback: 50,
		minKellyFraction: 0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
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
		const minKellyFraction = p.minKellyFraction as number;

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
			const sc = streaks[i];
			if (z === null || sc === 0) return null;

			const absStreak = Math.abs(sc);
			const winProb = Math.min(0.95, 0.5 + absStreak * 0.08);
			const kelly = 2 * winProb - 1;

			if (kelly > minKellyFraction) {
				if (z < -1.5 && sc < 0) {
					return createBuySignal(cleanData, i, `Streak Kelly buy: Z ${z.toFixed(2)}, Streak ${sc}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
				if (z > 1.5 && sc > 0) {
					return createSellSignal(cleanData, i, `Streak Kelly sell: Z ${z.toFixed(2)}, Streak ${sc}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_streak_exhaustion_reversion.executePrepared!(
			kelly_streak_exhaustion_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
