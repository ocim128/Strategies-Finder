import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeEfficiencyPhiExtremeReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 14)),
		phi_efficiency: Math.max(0.01, Math.abs(Number(params.phi_efficiency ?? 0.382))),
		close_loc_extreme: Math.max(0.01, Math.min(0.49, Number(params.close_loc_extreme ?? 0.15))) };
}

export const efficiency_phi_extreme_reversion: Strategy = {
	name: "Efficiency Phi Extreme Reversion",
	description: "When path efficiency is dead (below phi) and the close lands at the absolute extreme of its range, local liquidity is swept and must revert — guaranteed chop regime isolation.",
	defaultParams: {
		er_lookback: 14,
		phi_efficiency: 0.382,
		close_loc_extreme: 0.15 },
	paramLabels: {
		er_lookback: "ER Lookback",
		phi_efficiency: "Phi Efficiency",
		close_loc_extreme: "Close Location Extreme" },
	normalizeParams: normalizeEfficiencyPhiExtremeReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyPhiExtremeReversionParams(params);
		if (cleanData.length < p.er_lookback) return [];

		const er = buildEfficiencyRatio(cleanData, p.er_lookback);
		const closeLocation = extractBarMetricSeries(cleanData, "closeLocation");

		return createSignalLoop(cleanData, [er], (i) => {
			if (i < p.er_lookback) return null;
			const erVal = er[i];
			if (erVal === null) return null;

			if (erVal < p.phi_efficiency && closeLocation[i] < p.close_loc_extreme) {
				return createBuySignal(cleanData, i, `ER ${erVal.toFixed(3)} < phi, CL ${closeLocation[i].toFixed(3)} at low extreme — swept`);
			}
			if (erVal < p.phi_efficiency && closeLocation[i] > (1 - p.close_loc_extreme)) {
				return createSellSignal(cleanData, i, `ER ${erVal.toFixed(3)} < phi, CL ${closeLocation[i].toFixed(3)} at high extreme — swept`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["er_lookback", "phi_efficiency", "close_loc_extreme"] } };
