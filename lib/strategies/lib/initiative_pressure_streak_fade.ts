import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

type InitiativePressureStreakPrepared = {
	data: OHLCVData[];
	streakByLookback: Map<number, number[]>;
};

function normalizeInitiativeStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 5))),
	};
}

function prepareInitiativeStreakData(data: OHLCVData[]): InitiativePressureStreakPrepared {
	return {
		data: ensureCleanData(data),
		streakByLookback: new Map(),
	};
}

function getPreparedInitiativeStreakData(preparedData: unknown, data: OHLCVData[]): InitiativePressureStreakPrepared {
	if (preparedData && typeof preparedData === "object" && "streakByLookback" in preparedData) {
		return preparedData as InitiativePressureStreakPrepared;
	}
	return prepareInitiativeStreakData(data);
}

export const initiative_pressure_streak_fade: Strategy = {
	name: "Initiative Pressure Streak Fade",
	description: "Fades the ratio when initiative pressure (volume-backed directional commitment) is consistently in one direction for a streak of bars.",
	defaultParams: {
		lookback: 5,
	},
	paramLabels: {
		lookback: "Streak Length Threshold",
	},
	normalizeParams: normalizeInitiativeStreakParams,
	prepareFinderData: (data) => prepareInitiativeStreakData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedInitiativeStreakData(preparedData, data);
		const p = normalizeInitiativeStreakParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let streak = prepared.streakByLookback.get(lookback);
		if (!streak) {
			const initiativePressure = buildInitiativePressureSeries(prepared.data, lookback);
			const flags = initiativePressure.map(val => {
				if (val === null || val === 0) return 0;
				return val > 0 ? 1 : -1;
			});
			streak = buildStreakCount(flags);
			prepared.streakByLookback.set(lookback, streak);
		}

		return createSignalLoop(prepared.data, [], (i) => {
			if (i < lookback) return null;
			const s = streak[i];

			if (s <= -lookback) {
				return createBuySignal(prepared.data, i, `Initiative pressure negative streak fade: consecutive down bars (${s} <= -${lookback})`);
			}
			if (s >= lookback) {
				return createSellSignal(prepared.data, i, `Initiative pressure positive streak fade: consecutive up bars (${s} >= ${lookback})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		initiative_pressure_streak_fade.executePrepared?.(prepareInitiativeStreakData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
