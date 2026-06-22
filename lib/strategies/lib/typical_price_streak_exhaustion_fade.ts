import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

type StreakExhaustionPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	streak: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeStreakExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
	};
}

function prepareStreakExhaustionData(data: OHLCVData[]): StreakExhaustionPrepared {
	const clean = ensureCleanData(data);
	const typicalPrices = getTypicalPrices(clean);
	const returns = buildRateOfChange(typicalPrices, 1);
	const flags = returns.map(r => {
		if (r === null || r === 0) return 0;
		return r > 0 ? 1 : -1;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		typicalPrices,
		streak,
		zScoreByLookback: new Map(),
	};
}

function getPreparedStreakExhaustionData(preparedData: unknown, data: OHLCVData[]): StreakExhaustionPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as StreakExhaustionPrepared;
	}
	return prepareStreakExhaustionData(data);
}

export const typical_price_streak_exhaustion_fade: Strategy = {
	name: "Typical Price Streak Exhaustion Fade",
	description: "Fades typical price trends when typical price moves in the same direction for 5+ bars and z-score is extreme.",
	defaultParams: {
		lookback: 25,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeStreakExhaustionParams,
	prepareFinderData: (data) => prepareStreakExhaustionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedStreakExhaustionData(preparedData, data);
		const p = normalizeStreakExhaustionParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.typicalPrices, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			const s = prepared.streak[i];

			if (z <= -1.5 && s <= -5) {
				return createBuySignal(prepared.data, i, `Typical price streak exhaustion buy: Z-Score (${z.toFixed(2)}) <= -1.5 with consecutive down bars (${s} <= -5)`);
			}
			if (z >= 1.5 && s >= 5) {
				return createSellSignal(prepared.data, i, `Typical price streak exhaustion sell: Z-Score (${z.toFixed(2)}) >= 1.5 with consecutive up bars (${s} >= 5)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_streak_exhaustion_fade.executePrepared?.(prepareStreakExhaustionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
