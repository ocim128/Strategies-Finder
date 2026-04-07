import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyPhiRegimeJumpParams(params: StrategyParams): StrategyParams {
	const erLookback = Math.max(2, Math.round(params.erLookback ?? 13));
	const phiNoiseLimit = Math.min(1, Math.max(0, Number(params.phiNoiseLimit ?? 0.382)));
	const phiTrendLimit = Math.min(1, Math.max(phiNoiseLimit + 0.01, Number(params.phiTrendLimit ?? 0.618)));
	return { ...params, erLookback, phiNoiseLimit, phiTrendLimit };
}

export const efficiency_phi_regime_jump: Strategy = {
	name: "Efficiency Phi Regime Jump",
	description:
		"Surfs violent algorithmic regime shifts. Triggers only when Kaufman's Efficiency Ratio violently jumps from total noise (<0.382) to structural trend (>0.618) in a single measurement.",
	defaultParams: { erLookback: 13, phiNoiseLimit: 0.382, phiTrendLimit: 0.618 },
	paramLabels: { erLookback: "ER Lookback", phiNoiseLimit: "Phi Noise Limit", phiTrendLimit: "Phi Trend Limit" },
	normalizeParams: normalizeEfficiencyPhiRegimeJumpParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeEfficiencyPhiRegimeJumpParams(params);
		if (cleanData.length < np.erLookback + 2) return [];
		const er = buildEfficiencyRatio(cleanData, np.erLookback);
		return createSignalLoop(cleanData, [er], (i) => {
			const prev = er[i - 1];
			const curr = er[i];
			if (prev === null || curr === null) return null;
			if (prev < np.phiNoiseLimit && curr > np.phiTrendLimit) {
				if (cleanData[i].close > cleanData[i].open)
					return createBuySignal(cleanData, i, `ER regime jump ${prev.toFixed(3)} -> ${curr.toFixed(3)}`);
				if (cleanData[i].close < cleanData[i].open)
					return createSellSignal(cleanData, i, `ER regime jump ${prev.toFixed(3)} -> ${curr.toFixed(3)}`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["erLookback", "phiNoiseLimit", "phiTrendLimit"] } };
