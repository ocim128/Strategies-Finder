import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries, buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeSweepReclaimInitiativeAbsorptionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailWindow: Math.max(2, Math.round(params.trailWindow ?? 20)),
		initiativeZThreshold: Math.max(0, Math.abs(Number(params.initiativeZThreshold ?? 1.0))) };
}

export const sweep_reclaim_initiative_absorption: Strategy = {
	name: "Sweep Reclaim Initiative Absorption",
	description: "When a liquidity sweep-reclaim occurs and initiative pressure is simultaneously low, the sweep was a stop hunt absorbed by resting dealer liquidity — not driven by aggressive conviction. Enter in the reclaim direction because the mechanical stop-clearing is done.",
	defaultParams: {
		trailWindow: 20,
		initiativeZThreshold: 1.0 },
	paramLabels: {
		trailWindow: "Trail Window",
		initiativeZThreshold: "Initiative Z Threshold" },
	normalizeParams: normalizeSweepReclaimInitiativeAbsorptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSweepReclaimInitiativeAbsorptionParams(params);
		const trailWindow = p.trailWindow as number;
		const initiativeZThreshold = p.initiativeZThreshold as number;
		if (cleanData.length < trailWindow + 2) return [];

		const sweepReclaim = buildSweepReclaimSeries(cleanData, trailWindow);
		const ipSeries = buildInitiativePressureSeries(cleanData, trailWindow);
		const ipClean = ipSeries.map(v => v ?? 0);
		const ipZ = buildRollingZScore(ipClean, trailWindow);

		return createSignalLoop(cleanData, [ipZ], (i) => {
			if (i < trailWindow + 1) return null;
			const z = ipZ[i];
			if (z === null) return null;

			if (Math.abs(z) > initiativeZThreshold) return null;
			if (sweepReclaim[i] === null || Math.abs(sweepReclaim[i]!) < 0.3) return null;

			if (sweepReclaim[i]! > 0) {
				return createBuySignal(cleanData, i, `Bullish sweep-reclaim with passive absorption (IP z=${z.toFixed(2)})`);
			}
			if (sweepReclaim[i]! < 0) {
				return createSellSignal(cleanData, i, `Bearish sweep-reclaim with passive absorption (IP z=${z.toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailWindow", "initiativeZThreshold"] } };
