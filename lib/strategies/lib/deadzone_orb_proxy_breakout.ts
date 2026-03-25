import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		deadzoneLookback: Math.max(3, Math.round(params.deadzoneLookback ?? 20)),
		efficiencyCeiling: Number(params.efficiencyCeiling ?? 0.15),
		breakoutZscore: Number(params.breakoutZscore ?? 2.5)
	};
}

export const deadzone_orb_proxy_breakout: Strategy = {
	name: "Deadzone ORB Proxy Breakout",
	description: "Adapts the 1990s Opening Range Breakout (ORB) for 24/7 crypto markets by substituting 'time-of-day' with statistically confirmed 'deadzone structural efficiency', buying the first standard deviation pop.",
	defaultParams: { deadzoneLookback: 20, efficiencyCeiling: 0.15, breakoutZscore: 2.5 },
	paramLabels: { deadzoneLookback: "Deadzone Lookback", efficiencyCeiling: "Efficiency Ceiling", breakoutZscore: "Breakout ZScore" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["deadzoneLookback", "efficiencyCeiling", "breakoutZscore"] },
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
				if (z > p.breakoutZscore) {
					return createBuySignal(clean, i, "Deadzone Proxy Break Up");
				}
				if (z < -p.breakoutZscore) {
					return createSellSignal(clean, i, "Deadzone Proxy Break Down");
				}
			}

			return null;
		});
	}
};
