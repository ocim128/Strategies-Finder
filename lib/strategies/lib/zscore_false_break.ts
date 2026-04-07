import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeZscoreFalseBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		zscorePeriod: Math.max(2, Math.round(params.zscorePeriod ?? 20)),
		extremeLevel: Number(params.extremeLevel ?? 2.5),
		reversalDepth: Number(params.reversalDepth ?? 0.5) };
}

export const zscore_false_break: Strategy = {
	name: "ZScore False Break",
	description: "Zscore reaches extreme, appears to break further, then reverses without continuation, triggering fade entry.",
	defaultParams: {
		zscorePeriod: 20,
		extremeLevel: 2.5,
		reversalDepth: 0.5 },
	paramLabels: {
		zscorePeriod: "ZScore Period",
		extremeLevel: "Extreme Level",
		reversalDepth: "Reversal Depth" },
	normalizeParams: normalizeZscoreFalseBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const { zscorePeriod, extremeLevel, reversalDepth } = normalizeZscoreFalseBreakParams(params);
		
		if (cleanData.length < zscorePeriod) return [];

		const closes = getCloses(cleanData);
		const zscores = buildRollingZScore(closes, zscorePeriod);

		// State machines for tracking extremities
		// +1 for long fade (Zscore hit extreme high, fell by depth)
		// -1 for short fade (Zscore hit extreme low, rose by depth)
		let highestZ = -Infinity;
		let lowestZ = Infinity;
		let armedDirection = 0; // 1 = tracking top, -1 = tracking bottom

		const signals = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const z = zscores[i];
			if (z === null) continue;

			// Check arms
			if (z >= extremeLevel) {
				armedDirection = 1;
				highestZ = Math.max(highestZ, z);
			} else if (z <= -extremeLevel) {
				armedDirection = -1;
				lowestZ = Math.min(lowestZ, z);
			}

			// Check triggers
			if (armedDirection === 1) {
				if (z <= highestZ - reversalDepth) {
					signals[i] = -1; // Short trigger (fade the high)
					armedDirection = 0; // reset
					highestZ = -Infinity;
				}
			} else if (armedDirection === -1) {
				if (z >= lowestZ + reversalDepth) {
					signals[i] = 1; // Long trigger (fade the low)
					armedDirection = 0; // reset
					lowestZ = Infinity;
				}
			}
		}

		return createSignalLoop(cleanData, [signals], (i) => {
			if (signals[i] === 1) {
				return createBuySignal(cleanData, i, `Fade Deep Extreme (Rev > ${reversalDepth})`);
			}
			if (signals[i] === -1) {
				return createSellSignal(cleanData, i, `Fade High Extreme (Rev > ${reversalDepth})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["zscorePeriod", "extremeLevel", "reversalDepth"] } };
