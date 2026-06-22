import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

type CloseAcceptanceStreakPrepared = {
	data: OHLCVData[];
	streak: number[];
};

function normalizeAcceptanceStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 4))),
	};
}

function prepareAcceptanceStreakData(data: OHLCVData[]): CloseAcceptanceStreakPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	const flags = acceptance.map(a => {
		if (a > 0.5) return 1;
		if (a < -0.5) return -1;
		return 0;
	});
	const streak = buildStreakCount(flags);
	return {
		data: clean,
		streak,
	};
}

function getPreparedAcceptanceStreakData(preparedData: unknown, data: OHLCVData[]): CloseAcceptanceStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streak" in preparedData) {
		return preparedData as CloseAcceptanceStreakPrepared;
	}
	return prepareAcceptanceStreakData(data);
}

export const close_acceptance_streak_fade: Strategy = {
	name: "Close Acceptance Streak Fade",
	description: "Fades the ratio when close acceptance is consistently in one direction for a streak of bars.",
	defaultParams: {
		lookback: 4,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizeAcceptanceStreakParams,
	prepareFinderData: (data) => prepareAcceptanceStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedAcceptanceStreakData(preparedData, data);
		const p = normalizeAcceptanceStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		// We pass a dummy indicator array since all computations are already cached
		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = prepared.streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Close acceptance negative streak fade: consecutive down bars (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Close acceptance positive streak fade: consecutive up bars (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_streak_fade.executePrepared?.(prepareAcceptanceStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
