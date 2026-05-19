import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

const EXTREME_LOOKBACK_BARS = 5;

function normalizeExtremeDisplacementReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		z_lookback: Math.max(2, Math.round(params.z_lookback ?? 55)),
		extreme_z: Math.max(0, Number(params.extreme_z ?? 3.0)),
		reentry_z: Math.max(0, Number(params.reentry_z ?? 2.0)),
	};
}

function hadRecentExtreme(zScore: (number | null)[], index: number, threshold: number, side: "low" | "high"): boolean {
	const start = Math.max(0, index - EXTREME_LOOKBACK_BARS);
	for (let j = start; j < index; j++) {
		const value = zScore[j];
		if (value === null) continue;
		if (side === "low" && value < -threshold) return true;
		if (side === "high" && value > threshold) return true;
	}
	return false;
}

export const extreme_displacement_reversion: Strategy = {
	name: "Extreme Displacement Reversion",
	description: "Trades snap-back confirmation after recent three-sigma price displacement extremes.",
	defaultParams: {
		z_lookback: 55,
		extreme_z: 3.0,
		reentry_z: 2.0,
	},
	paramLabels: {
		z_lookback: "Z-Score Lookback",
		extreme_z: "Extreme Z",
		reentry_z: "Reentry Z",
	},
	normalizeParams: normalizeExtremeDisplacementReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeExtremeDisplacementReversionParams(params);
		const zLookback = p.z_lookback as number;
		const extremeZ = p.extreme_z as number;
		const reentryZ = p.reentry_z as number;
		if (cleanData.length < zLookback + EXTREME_LOOKBACK_BARS + 1) return [];

		const closes = getCloses(cleanData);
		const zScore = buildRollingZScore(closes, zLookback);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < zLookback + EXTREME_LOOKBACK_BARS) return null;

			const currentZ = zScore[i];
			const previousZ = zScore[i - 1];
			if (currentZ === null || previousZ === null) return null;

			if (hadRecentExtreme(zScore, i, extremeZ, "low") && previousZ <= -reentryZ && currentZ > -reentryZ) {
				return createBuySignal(cleanData, i, "Extreme downside displacement snap-back");
			}
			if (hadRecentExtreme(zScore, i, extremeZ, "high") && previousZ >= reentryZ && currentZ < reentryZ) {
				return createSellSignal(cleanData, i, "Extreme upside displacement snap-back");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["z_lookback", "extreme_z", "reentry_z"],
	},
};
