import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeEfficiencyPhiVelocitySnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		phi_er_limit: Math.max(0.01, Math.abs(Number(params.phi_er_limit ?? 0.382))),
		velocity_z_min: Math.max(0.5, Math.abs(Number(params.velocity_z_min ?? 2.0))) };
}

export const efficiency_phi_velocity_snap: Strategy = {
	name: "Efficiency Phi Velocity Snap",
	description: "When path efficiency decays below phi combined with an extreme Z-score in price velocity, the current thrust is perfectly inefficient and guarantees a mean-reverting snapback.",
	defaultParams: {
		lookback: 14,
		phi_er_limit: 0.382,
		velocity_z_min: 2.0 },
	paramLabels: {
		lookback: "Lookback",
		phi_er_limit: "Phi ER Limit",
		velocity_z_min: "Min Velocity Z-Score" },
	normalizeParams: normalizeEfficiencyPhiVelocitySnapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyPhiVelocitySnapParams(params);
		if (cleanData.length < p.lookback) return [];

		const er = buildEfficiencyRatio(cleanData, p.lookback);
		const closes = cleanData.map(d => d.close);
		const roc = buildRateOfChange(closes, p.lookback);
		const rocValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			rocValues[i] = roc[i] ?? 0;
		}
		const rocZ = buildRollingZScore(rocValues, p.lookback);

		return createSignalLoop(cleanData, [er, rocZ], (i) => {
			if (i < p.lookback) return null;
			const erVal = er[i];
			const zVal = rocZ[i];
			if (erVal === null || zVal === null) return null;

			if (erVal < p.phi_er_limit && zVal < -p.velocity_z_min) {
				return createBuySignal(cleanData, i, `ER ${erVal.toFixed(3)} < phi, ROC Z ${zVal.toFixed(2)} < -${p.velocity_z_min}, snap back up`);
			}
			if (erVal < p.phi_er_limit && zVal > p.velocity_z_min) {
				return createSellSignal(cleanData, i, `ER ${erVal.toFixed(3)} < phi, ROC Z ${zVal.toFixed(2)} > ${p.velocity_z_min}, snap back down`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_er_limit", "velocity_z_min"] } };
