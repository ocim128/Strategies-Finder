import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

type CloseLocationStreakPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizeLocationStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 4))),
	};
}

function prepareLocationStreakData(data: OHLCVData[]): CloseLocationStreakPrepared {
	const clean = ensureCleanData(data);
	const closeLocation = buildCloseLocationSeries(clean);
	const flags = closeLocation.map(c => {
		if (c > 0.70) return 1;
		if (c < 0.30) return -1;
		return 0;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedLocationStreakData(preparedData: unknown, data: OHLCVData[]): CloseLocationStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as CloseLocationStreakPrepared;
	}
	return prepareLocationStreakData(data);
}

export const close_location_streak_fade: Strategy = {
	name: "Close Location Streak Fade",
	description: "Fades the ratio when close location is consistently near the extremes (top 30% or bottom 30%) for a streak of bars.",
	defaultParams: {
		lookback: 4,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizeLocationStreakParams,
	prepareFinderData: (data) => prepareLocationStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedLocationStreakData(preparedData, data);
		const p = normalizeLocationStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = prepared.streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Close location low streak fade: consecutive low bars (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Close location high streak fade: consecutive high bars (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_location_streak_fade.executePrepared?.(prepareLocationStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
