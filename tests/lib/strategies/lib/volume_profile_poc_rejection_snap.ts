import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeVolumeProfilePocRejectionSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 50)),
		dist_pct_min: Math.max(0.1, Math.abs(Number(params.dist_pct_min ?? 1.5))),
		er_max: Math.max(0.01, Math.abs(Number(params.er_max ?? 0.3))) };
}

export const volume_profile_poc_rejection_snap: Strategy = {
	name: "Volume Profile POC Rejection Snap",
	description: "A rapid price spike away from the POC with a terribly low efficiency ratio is a false expansion that will instantly snap back to the liquidity node.",
	defaultParams: {
		lookback: 50,
		dist_pct_min: 1.5,
		er_max: 0.3 },
	paramLabels: {
		lookback: "Lookback",
		dist_pct_min: "Min Distance %",
		er_max: "Max Efficiency Ratio" },
	normalizeParams: normalizeVolumeProfilePocRejectionSnapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeProfilePocRejectionSnapParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const vp = calculateVolumeProfile(cleanData, p.lookback, 10);
		const er = buildEfficiencyRatio(cleanData, p.lookback);

		return createSignalLoop(cleanData, [vp.poc, er], (i) => {
			if (i < p.lookback) return null;
			const poc = vp.poc[i];
			const erVal = er[i];
			if (poc === null || poc <= 0 || erVal === null) return null;

			if (erVal >= p.er_max) return null;

			const distPct = Math.abs(closes[i] - poc) / poc * 100;
			if (distPct < p.dist_pct_min) return null;

			if (closes[i] < poc) {
				return createBuySignal(cleanData, i, `Close ${distPct.toFixed(2)}% below POC, ER ${erVal.toFixed(3)} < ${p.er_max}, snap back`);
			}
			return createSellSignal(cleanData, i, `Close ${distPct.toFixed(2)}% above POC, ER ${erVal.toFixed(3)} < ${p.er_max}, snap back`);
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "dist_pct_min", "er_max"] } };
