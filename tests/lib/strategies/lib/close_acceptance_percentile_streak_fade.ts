import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildStreakCount } from "./price-action-statistics-core";

type CloseAcceptancePercentileStreakPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizePercentileStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 4))),
	};
}

function preparePercentileStreakData(data: OHLCVData[]): CloseAcceptancePercentileStreakPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	const percentile = buildPercentileRank(acceptance, 20);
	const flags = percentile.map(p => {
		if (p === null) return 0;
		if (p < 0.20) return -1;
		if (p > 0.80) return 1;
		return 0;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedPercentileStreakData(preparedData: unknown, data: OHLCVData[]): CloseAcceptancePercentileStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as CloseAcceptancePercentileStreakPrepared;
	}
	return preparePercentileStreakData(data);
}

export const close_acceptance_percentile_streak_fade: Strategy = {
	name: "Close Acceptance Percentile Streak Fade",
	description: "Fades the ratio when close acceptance percentile rank remains at extremes (above 0.80 or below 0.20) for a streak of bars.",
	defaultParams: {
		lookback: 4,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizePercentileStreakParams,
	prepareFinderData: (data) => preparePercentileStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedPercentileStreakData(preparedData, data);
		const p = normalizePercentileStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = prepared.streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Close acceptance percentile negative streak fade: consecutive low percentile bars (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Close acceptance percentile positive streak fade: consecutive high percentile bars (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_percentile_streak_fade.executePrepared?.(preparePercentileStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
