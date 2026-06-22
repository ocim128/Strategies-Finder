import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

type TypicalPriceStreakPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizeTypicalStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 5))),
	};
}

function prepareTypicalStreakData(data: OHLCVData[]): TypicalPriceStreakPrepared {
	const clean = ensureCleanData(data);
	const typical = getTypicalPrices(clean);
	const flags = new Array(clean.length).fill(0);
	for (let i = 1; i < clean.length; i++) {
		if (typical[i] > typical[i - 1]) {
			flags[i] = 1;
		} else if (typical[i] < typical[i - 1]) {
			flags[i] = -1;
		}
	}
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedTypicalStreakData(preparedData: unknown, data: OHLCVData[]): TypicalPriceStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as TypicalPriceStreakPrepared;
	}
	return prepareTypicalStreakData(data);
}

export const typical_price_direction_streak_fade: Strategy = {
	name: "Typical Price Direction Streak Fade",
	description: "Fades the ratio when the typical price has printed a consecutive streak of increases or decreases.",
	defaultParams: {
		lookback: 5,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizeTypicalStreakParams,
	prepareFinderData: (data) => prepareTypicalStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedTypicalStreakData(preparedData, data);
		const p = normalizeTypicalStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = prepared.streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Typical price negative streak fade: consecutive down bars (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Typical price positive streak fade: consecutive up bars (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_direction_streak_fade.executePrepared?.(prepareTypicalStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
