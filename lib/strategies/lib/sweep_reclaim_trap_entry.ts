import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";

function normalizeSweepReclaimTrapEntryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailWindow: Math.max(2, Math.round(params.trailWindow ?? 20)),
		reclaimThreshold: Math.max(0, Math.abs(Number(params.reclaimThreshold ?? 0.5))) };
}

export const sweep_reclaim_trap_entry: Strategy = {
	name: "Sweep Reclaim Trap Entry",
	description: "When price sweeps a trailing boundary and immediately reclaims back inside the range, the liquidity sweep has failed and trapped participants on the wrong side. Enter in the reclaim direction.",
	defaultParams: {
		trailWindow: 20,
		reclaimThreshold: 0.5 },
	paramLabels: {
		trailWindow: "Trail Window",
		reclaimThreshold: "Reclaim Threshold" },
	normalizeParams: normalizeSweepReclaimTrapEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSweepReclaimTrapEntryParams(params);
		const trailWindow = p.trailWindow as number;
		const reclaimThreshold = p.reclaimThreshold as number;
		if (cleanData.length < trailWindow + 2) return [];

		const sweepReclaim = buildSweepReclaimSeries(cleanData, trailWindow);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < trailWindow) return null;
			const sr = sweepReclaim[i];
			if (sr === null) return null;

			if (sr > reclaimThreshold) {
				return createBuySignal(cleanData, i, `Bullish sweep-reclaim trap (${sr.toFixed(3)}) — shorts trapped`);
			}
			if (sr < -reclaimThreshold) {
				return createSellSignal(cleanData, i, `Bearish sweep-reclaim trap (${sr.toFixed(3)}) — longs trapped`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailWindow", "reclaimThreshold"] } };
