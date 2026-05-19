import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore, buildStreakCount } from "./price-action-statistics-core";

function normalizeDualSpeedMomentumCompositeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streak_length: Math.max(1, Math.round(params.streak_length ?? 5)),
		zscore_lookback: Math.max(2, Math.round(params.zscore_lookback ?? 20)),
		zscore_threshold: Math.max(0, Number(params.zscore_threshold ?? 2.5)),
	};
}

export const dual_speed_momentum_composite: Strategy = {
	name: "Dual Speed Momentum Composite",
	description: "Captures trend starts from either persistent close streaks or sudden z-score displacement shocks.",
	defaultParams: {
		streak_length: 5,
		zscore_lookback: 20,
		zscore_threshold: 2.5,
	},
	paramLabels: {
		streak_length: "Streak Length",
		zscore_lookback: "Z-Score Lookback",
		zscore_threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeDualSpeedMomentumCompositeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualSpeedMomentumCompositeParams(params);
		const streakLength = p.streak_length as number;
		const zLookback = p.zscore_lookback as number;
		const zThreshold = p.zscore_threshold as number;
		if (cleanData.length < zLookback + 2) return [];

		const closes = getCloses(cleanData);
		const closeFlags = closes.map((close, i) => {
			if (i === 0) return 0;
			if (close > closes[i - 1]) return 1;
			if (close < closes[i - 1]) return -1;
			return 0;
		});
		const streak = buildStreakCount(closeFlags);
		const zScore = buildRollingZScore(closes, zLookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < zLookback) return null;

			const z = zScore[i];
			if (z === null) return null;

			const bullish = streak[i] >= streakLength || z >= zThreshold;
			const bearish = streak[i] <= -streakLength || z <= -zThreshold;
			if (bullish && bearish) return null;
			if (bullish) {
				return createBuySignal(cleanData, i, "Dual-speed momentum bullish");
			}
			if (bearish) {
				return createSellSignal(cleanData, i, "Dual-speed momentum bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streak_length", "zscore_lookback", "zscore_threshold"],
	},
};
