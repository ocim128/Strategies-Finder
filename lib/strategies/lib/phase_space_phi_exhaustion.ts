import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizePhaseSpacePhiExhaustionParams(params: StrategyParams): StrategyParams {
	const rocPeriod = Math.max(1, Math.round(params.rocPeriod ?? 3));
	const zscoreLookback = Math.max(10, Math.round(params.zscoreLookback ?? 100));
	const phiZScore = Math.max(0.5, Number(params.phiZScore ?? 1.618));
	return { ...params, rocPeriod, zscoreLookback, phiZScore };
}

export const phase_space_phi_exhaustion: Strategy = {
	name: "Phase Space Phi Exhaustion",
	description:
		"Fades momentum spikes when the rate-of-change Z-score hits the golden 1.618 threshold, capturing structural fatigue before classic overbought/oversold indicators fire.",
	defaultParams: { rocPeriod: 3, zscoreLookback: 100, phiZScore: 1.618 },
	paramLabels: { rocPeriod: "ROC Period", zscoreLookback: "Z-Score Lookback", phiZScore: "Phi Z-Score" },
	normalizeParams: normalizePhaseSpacePhiExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizePhaseSpacePhiExhaustionParams(params);
		const minBars = np.rocPeriod + np.zscoreLookback + 2;
		if (cleanData.length < minBars) return [];

		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, np.rocPeriod);
		const rocFilled = roc.map((v) => v ?? 0);
		const zscore = buildRollingZScore(rocFilled, np.zscoreLookback);

		const signals = [];
		for (let i = minBars; i < cleanData.length; i++) {
			const z = zscore[i];
			const zPrev = zscore[i - 1];
			if (z === null || zPrev === null) continue;

			if (zPrev >= -np.phiZScore && z < -np.phiZScore && cleanData[i].close > cleanData[i].open) {
				signals.push(createBuySignal(cleanData, i, `ROC Z-score crossed below -${np.phiZScore} with bullish candle`));
			}
			if (zPrev <= np.phiZScore && z > np.phiZScore && cleanData[i].close < cleanData[i].open) {
				signals.push(createSellSignal(cleanData, i, `ROC Z-score crossed above ${np.phiZScore} with bearish candle`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rocPeriod", "zscoreLookback", "phiZScore"],
	},
};
