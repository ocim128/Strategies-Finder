import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapDeviationStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streak_threshold: Math.max(2, Math.round(params.streak_threshold ?? 5)),
	};
}

export const vwap_deviation_streak: Strategy = {
	name: "VWAP Deviation Streak",
	description: "Consecutive bars on the same side of VWAP measure directional persistence relative to value, not magnitude. When streak reaches threshold, the one-sided value positioning is exhausted. This measures TIME spent away from value, not distance.",
	defaultParams: {
		streak_threshold: 5,
	},
	paramLabels: {
		streak_threshold: "Streak Threshold",
	},
	normalizeParams: normalizeVwapDeviationStreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapDeviationStreakParams(params);
		if (cleanData.length < 3) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const flags: number[] = closes.map((c, i) => {
			const v = vwap[i];
			if (v === null) return 0;
			return c > v ? 1 : c < v ? -1 : 0;
		});
		const streak = buildStreakCount(flags);

		return createSignalLoop(cleanData, [], (i) => {
			const s = streak[i];

			if (s <= -(p.streak_threshold as number)) {
				return createBuySignal(cleanData, i, `Below VWAP for ${Math.abs(s)} consecutive bars — discount exhaustion`);
			}
			if (s >= p.streak_threshold) {
				return createSellSignal(cleanData, i, `Above VWAP for ${s} consecutive bars — premium exhaustion`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streak_threshold"],
	},
};
