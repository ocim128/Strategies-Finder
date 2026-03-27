import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		deadzoneLookback: Math.max(3, Math.round(params.deadzoneLookback ?? 20)),
		efficiencyCeiling: Number(params.efficiencyCeiling ?? 0.15),
		breakoutZscore: Number(params.breakoutZscore ?? 2.0),
		requiredCloses: Math.max(2, Math.round(params.requiredCloses ?? 2)) // Typically wait for 2 bars
	};
}

export const deadzone_consecutive_closes: Strategy = {
	name: "Deadzone Consecutive Closes",
	description: "Removes false breakdowns by demanding the breakout Z-Score threshold is breached and held for multiple consecutive closes before triggering entry.",
	defaultParams: { deadzoneLookback: 20, efficiencyCeiling: 0.15, breakoutZscore: 2.0, requiredCloses: 2 },
	paramLabels: { deadzoneLookback: "Deadzone Lookback", efficiencyCeiling: "Efficiency Ceiling", breakoutZscore: "Breakout ZScore", requiredCloses: "Consecutive Closes" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["deadzoneLookback", "efficiencyCeiling", "breakoutZscore", "requiredCloses"] },
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
			if (i < p.requiredCloses) return null;
			
			const e = er[i-p.requiredCloses]; // efficiency going into the breakout sequence

			if (e === null) return null;

			// Deadzone filter check at the start of the breakout sequence
			if (e < p.efficiencyCeiling) {
				
				let consecutiveUp = true;
				let consecutiveDown = true;

				for (let j = 0; j < p.requiredCloses; j++) {
					const z = zscore[i - j];
					if (z === null || z <= p.breakoutZscore) {
						consecutiveUp = false;
					}
					if (z === null || z >= -p.breakoutZscore) {
						consecutiveDown = false;
					}
				}

				if (consecutiveUp) {
					return createBuySignal(clean, i, "Held Break Up");
				}
				if (consecutiveDown) {
					return createSellSignal(clean, i, "Held Break Down");
				}
			}

			return null;
		});
	}
};
