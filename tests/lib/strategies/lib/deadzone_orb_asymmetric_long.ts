import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore, buildRateOfChange } from "./price-action-statistics-core";
import { buildDeadzoneOrbAsymmetricLivePreview } from "./deadzone-orb-asymmetric-live-preview";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		deadzoneLookback: Math.max(3, Math.round(params.deadzoneLookback ?? 20)),
		efficiencyCeiling: Number(params.efficiencyCeiling ?? 0.15),
		longBreakoutZscore: Number(params.longBreakoutZscore ?? 2.0),
		shortBreakoutZscore: Number(params.shortBreakoutZscore ?? 3.0)
	};
}

export const deadzone_orb_asymmetric_long: Strategy = {
	name: "Deadzone ORB Asymmetric Long",
	description: "Easier longs (lower zscore threshold) than shorts - bullish bias assuming crypto long-term uptrend during deadzone exits.",
	defaultParams: { deadzoneLookback: 20, efficiencyCeiling: 0.15, longBreakoutZscore: 2.0, shortBreakoutZscore: 3.0 },
	paramLabels: { deadzoneLookback: "Deadzone Lookback", efficiencyCeiling: "Efficiency Ceiling", longBreakoutZscore: "Long Breakout ZScore", shortBreakoutZscore: "Short Breakout ZScore" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["deadzoneLookback", "efficiencyCeiling", "longBreakoutZscore", "shortBreakoutZscore"] },
	entryPreview: (data, params) => buildDeadzoneOrbAsymmetricLivePreview(data, normalizeParams(params)),
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.deadzoneLookback * 2) return [];

		const closes = getCloses(clean);
		const er = buildEfficiencyRatio(clean, p.deadzoneLookback);
		const roc = buildRateOfChange(closes, 1);
		const cleanRoc = roc.map(r => r ?? 0);
		const zscore = buildRollingZScore(cleanRoc, p.deadzoneLookback);

		return createSignalLoop(clean, [er, zscore], (i) => {
			if (i === 0) return null;
			
			const e = er[i-1];
			const z = zscore[i]; 

			if (e === null || z === null) return null;

			if (e < p.efficiencyCeiling) {
				// EASIER LONGS: lower threshold for longs
				if (z > p.longBreakoutZscore) {
					return createBuySignal(clean, i, "Asymmetric Long Breakout");
				}
				// HARDER SHORTS: requires stronger signal
				if (z < -p.shortBreakoutZscore) {
					return createSellSignal(clean, i, "Asymmetric Short Breakout");
				}
			}

			return null;
		});
	}
};
