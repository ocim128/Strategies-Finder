import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

type BodyDirectionStreakPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizeBodyStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 5))),
	};
}

function prepareBodyStreakData(data: OHLCVData[]): BodyDirectionStreakPrepared {
	const clean = ensureCleanData(data);
	const flags = clean.map(bar => {
		if (bar.close > bar.open) return 1;
		if (bar.close < bar.open) return -1;
		return 0;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedBodyStreakData(preparedData: unknown, data: OHLCVData[]): BodyDirectionStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as BodyDirectionStreakPrepared;
	}
	return prepareBodyStreakData(data);
}

export const body_direction_streak_fade: Strategy = {
	name: "Body Direction Streak Fade",
	description: "Fades the ratio after a consecutive streak of green (close > open) or red (close < open) candles.",
	defaultParams: {
		lookback: 5,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizeBodyStreakParams,
	prepareFinderData: (data) => prepareBodyStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedBodyStreakData(preparedData, data);
		const p = normalizeBodyStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = prepared.streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Body direction negative streak fade: consecutive red candles (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Body direction positive streak fade: consecutive green candles (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		body_direction_streak_fade.executePrepared?.(prepareBodyStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
