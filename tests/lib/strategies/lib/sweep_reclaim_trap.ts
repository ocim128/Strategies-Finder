import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";

function normalizeSweepReclaimTrapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)) };
}

export const sweep_reclaim_trap: Strategy = {
	name: "Sweep Reclaim Trap",
	description: "When price sweeps beyond a trailing N-bar extreme but closes back inside, breakout traders are trapped and liquidity providers are rewarded. The reclaim direction predicts reversal.",
	defaultParams: {
		lookback: 20 },
	paramLabels: {
		lookback: "Trailing Lookback" },
	normalizeParams: normalizeSweepReclaimTrapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSweepReclaimTrapParams(params);
		if (cleanData.length < p.lookback) return [];

		const sweepSeries = buildSweepReclaimSeries(cleanData, p.lookback);

		return createSignalLoop(cleanData, [sweepSeries], (i) => {
			const sweep = sweepSeries[i];
			if (sweep === null || sweep === 0) return null;

			if (sweep > 0) {
				return createBuySignal(cleanData, i, `Bullish sweep reclaim: ${sweep.toFixed(4)}, shorts trapped`);
			}
			if (sweep < 0) {
				return createSellSignal(cleanData, i, `Bearish sweep reclaim: ${sweep.toFixed(4)}, longs trapped`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
