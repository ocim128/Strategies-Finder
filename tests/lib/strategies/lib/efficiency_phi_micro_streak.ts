import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio, buildStreakCount } from "./price-action-statistics-core";

function normalizeEfficiencyPhiMicroStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 5)),
		phi_efficiency: Math.max(0, Math.min(1, Number(params.phi_efficiency ?? 0.382))),
		streak_min: Math.max(2, Math.round(params.streak_min ?? 4)),
	};
}

export const efficiency_phi_micro_streak: Strategy = {
	name: "Efficiency Phi Micro Streak",
	description: "A consecutive streak of bars where path efficiency remains above 0.382 represents an unnatural swept orderbook. Trade the exhaustion fade the moment the streak breaks.",
	defaultParams: {
		er_lookback: 5,
		phi_efficiency: 0.382,
		streak_min: 4,
	},
	paramLabels: {
		er_lookback: "ER Lookback",
		phi_efficiency: "Phi Efficiency",
		streak_min: "Streak Minimum",
	},
	normalizeParams: normalizeEfficiencyPhiMicroStreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyPhiMicroStreakParams(params);
		if (cleanData.length < p.er_lookback + p.streak_min) return [];

		const erRaw = buildEfficiencyRatio(cleanData, p.er_lookback);
		const flags = erRaw.map(v => (v !== null && v > p.phi_efficiency) ? 1 : 0);
		const streaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [erRaw], (i) => {
			if (i < p.er_lookback + p.streak_min) return null;
			const erVal = erRaw[i];
			if (erVal === null) return null;

			const prevStreak = streaks[i - 1];
			const currentStreak = streaks[i];
			if (currentStreak === 0 && prevStreak >= p.streak_min && erVal < p.phi_efficiency) {
				if (cleanData[i].close < cleanData[i].open)
					return createBuySignal(cleanData, i, `Efficiency up-streak broken after ${prevStreak} bars`);
				if (cleanData[i].close > cleanData[i].open)
					return createSellSignal(cleanData, i, `Efficiency down-streak broken after ${prevStreak} bars`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["er_lookback", "phi_efficiency", "streak_min"],
	},
};





