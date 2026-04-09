import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeSweepReclaimMomentumContinuationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailWindow: Math.max(2, Math.round(params.trailWindow ?? 20)),
		rocConfirmation: Math.max(0, Math.abs(Number(params.rocConfirmation ?? 0.5))) };
}

export const sweep_reclaim_momentum_continuation: Strategy = {
	name: "Sweep Reclaim Momentum Continuation",
	description: "When price sweeps a trailing boundary and reclaims, the liquidity sweep has cleared stop-loss clusters. Enter in the reclaim direction with momentum confirmation — the removed stops reduce near-term resistance.",
	defaultParams: {
		trailWindow: 20,
		rocConfirmation: 0.5 },
	paramLabels: {
		trailWindow: "Trail Window",
		rocConfirmation: "ROC Confirmation" },
	normalizeParams: normalizeSweepReclaimMomentumContinuationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSweepReclaimMomentumContinuationParams(params);
		const trailWindow = p.trailWindow as number;
		const rocThreshold = p.rocConfirmation as number;
		if (cleanData.length < trailWindow + 2) return [];

		const closes = getCloses(cleanData);
		const sweepReclaim = buildSweepReclaimSeries(cleanData, trailWindow);
		const roc = buildRateOfChange(closes, 1);

		return createSignalLoop(cleanData, [roc], (i) => {
			if (i < trailWindow) return null;
			const sr = sweepReclaim[i];
			const r = roc[i];
			if (sr === null || r === null) return null;

			if (sr > 0 && r > rocThreshold) {
				return createBuySignal(cleanData, i, `Bullish sweep-reclaim (${sr.toFixed(3)}) with momentum (ROC=${(r * 100).toFixed(1)}%)`);
			}
			if (sr < 0 && r < -rocThreshold) {
				return createSellSignal(cleanData, i, `Bearish sweep-reclaim (${sr.toFixed(3)}) with momentum (ROC=${(r * 100).toFixed(1)}%)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailWindow", "rocConfirmation"] } };
