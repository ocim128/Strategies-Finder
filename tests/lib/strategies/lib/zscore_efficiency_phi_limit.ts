import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeZscoreEfficiencyPhiLimitParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		phi_constant: Math.max(0.01, Math.abs(Number(params.phi_constant ?? 0.382))) };
}

export const zscore_efficiency_phi_limit: Strategy = {
	name: "Z-Score Efficiency Phi Limit",
	description: "Dynamic Z-score threshold equal to (phi / ER) creates an elastic boundary that widens in chop and tightens in trends, forcing extreme mean-reversion only when the path is mathematically chaotic.",
	defaultParams: {
		lookback: 20,
		phi_constant: 0.382 },
	paramLabels: {
		lookback: "Lookback",
		phi_constant: "Phi Constant" },
	normalizeParams: normalizeZscoreEfficiencyPhiLimitParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeZscoreEfficiencyPhiLimitParams(params);
		if (cleanData.length < p.lookback) return [];

		const er = buildEfficiencyRatio(cleanData, p.lookback);
		const closes = getCloses(cleanData);
		const zscore = buildRollingZScore(closes, p.lookback);

		return createSignalLoop(cleanData, [er, zscore], (i) => {
			if (i < p.lookback) return null;
			const erVal = er[i];
			const zVal = zscore[i];
			if (erVal === null || zVal === null) return null;

			const dynamicThreshold = p.phi_constant / (erVal + 0.01);
			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (zVal < -dynamicThreshold && bullishBar) {
				return createBuySignal(cleanData, i, `Z ${zVal.toFixed(3)} < -${dynamicThreshold.toFixed(3)} (phi/ER), bullish snap`);
			}
			if (zVal > dynamicThreshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Z ${zVal.toFixed(3)} > ${dynamicThreshold.toFixed(3)} (phi/ER), bearish snap`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_constant"] } };
