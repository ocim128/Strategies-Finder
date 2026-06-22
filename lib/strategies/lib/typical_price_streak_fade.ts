import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

type TypicalPriceStreakFadePrepared = {
	data: OHLCVData[];
	typical: number[];
	streak: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeTypicalStreakFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.8)),
	};
}

function prepareTypicalStreakFadeData(data: OHLCVData[]): TypicalPriceStreakFadePrepared {
	const clean = ensureCleanData(data);
	const typical = getTypicalPrices(clean);
	const returns = buildRateOfChange(typical, 1);
	const flags = returns.map(r => {
		if (r === null || r === 0) return 0;
		return r > 0 ? 1 : -1;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		typical,
		streak,
		zScoreByLookback: new Map(),
	};
}

function getPreparedTypicalStreakFadeData(preparedData: unknown, data: OHLCVData[]): TypicalPriceStreakFadePrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as TypicalPriceStreakFadePrepared;
	}
	return prepareTypicalStreakFadeData(data);
}

export const typical_price_streak_fade: Strategy = {
	name: "Typical Price Streak Fade",
	description: "Fades typical price trends when typical price prints a 4-bar directional streak and the typical price z-score is extreme.",
	defaultParams: {
		lookback: 30,
		threshold: 1.8,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeTypicalStreakFadeParams,
	prepareFinderData: (data) => prepareTypicalStreakFadeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedTypicalStreakFadeData(preparedData, data);
		const p = normalizeTypicalStreakFadeParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.typical, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			const s = prepared.streak[i];

			if (z <= -threshold && s <= -4) {
				return createBuySignal(prepared.data, i, `Typical price streak fade buy: Z-Score (${z.toFixed(2)}) <= -${threshold.toFixed(2)} with negative streak (${s} <= -4)`);
			}
			if (z >= threshold && s >= 4) {
				return createSellSignal(prepared.data, i, `Typical price streak fade sell: Z-Score (${z.toFixed(2)}) >= ${threshold.toFixed(2)} with positive streak (${s} >= 4)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_streak_fade.executePrepared?.(prepareTypicalStreakFadeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
