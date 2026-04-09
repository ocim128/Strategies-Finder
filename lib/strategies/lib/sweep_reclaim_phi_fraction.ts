import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeSweepReclaimPhiFractionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		phi_fraction: Math.max(0.01, Math.abs(Number(params.phi_fraction ?? 0.382))) };
}

export const sweep_reclaim_phi_fraction: Strategy = {
	name: "Sweep Reclaim Phi Fraction",
	description: "A liquidity sweep is only significant if the reclaim constitutes more than the golden ratio of the bar's True Range, proving the extreme was rejected by heavy passive limits.",
	defaultParams: {
		lookback: 14,
		phi_fraction: 0.382 },
	paramLabels: {
		lookback: "Sweep Lookback",
		phi_fraction: "Phi Fraction" },
	normalizeParams: normalizeSweepReclaimPhiFractionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSweepReclaimPhiFractionParams(params);
		if (cleanData.length < p.lookback) return [];

		const sweepSeries = buildSweepReclaimSeries(cleanData, p.lookback);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");

		return createSignalLoop(cleanData, [sweepSeries], (i) => {
			const sweep = sweepSeries[i];
			if (sweep === null) return null;
			const tr = trueRange[i];
			if (tr <= 0) return null;

			const threshold = tr * p.phi_fraction;
			const bullishBar = cleanData[i].close > cleanData[i].open;

			if (sweep > threshold && bullishBar) {
				return createBuySignal(cleanData, i, `Sweep reclaim ${sweep.toFixed(4)} > phi * TR ${threshold.toFixed(4)}, bullish rejection`);
			}
			if (sweep < -threshold && !bullishBar) {
				return createSellSignal(cleanData, i, `Sweep reclaim ${sweep.toFixed(4)} < -phi * TR, bearish rejection`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_fraction"] } };
