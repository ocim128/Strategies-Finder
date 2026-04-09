import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

function normalizeCloseAcceptanceEntropyStructureBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 30)),
		structureRank: Math.max(0, Math.min(100, Number(params.structureRank ?? 15))) };
}

export const close_acceptance_entropy_structure_break: Strategy = {
	name: "Close Acceptance Entropy Structure Break",
	description: "When entropy of close acceptance drops to a percentile low, bars are settling in a predictable pattern — dealer on autopilot. The first bar that breaks this low-entropy regime with a sharp acceptance flip signals the pattern has been disrupted. Enter in the disruption direction.",
	defaultParams: {
		entropyWindow: 30,
		structureRank: 15 },
	paramLabels: {
		entropyWindow: "Entropy Window",
		structureRank: "Structure Rank Max" },
	normalizeParams: normalizeCloseAcceptanceEntropyStructureBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseAcceptanceEntropyStructureBreakParams(params);
		const entropyWindow = p.entropyWindow as number;
		const structureRank = p.structureRank as number;
		if (cleanData.length < entropyWindow + 2) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const entropy = buildRollingEntropy(acceptance, entropyWindow);
		const entropyClean = entropy.map(v => v ?? 0);
		const entropyRank = buildPercentileRank(entropyClean, entropyWindow);

		return createSignalLoop(cleanData, [entropyRank], (i) => {
			if (i < entropyWindow + 1) return null;
			const priorRank = entropyRank[i - 1];
			if (priorRank === null || priorRank >= structureRank / 100) return null;

			if (acceptance[i - 1] <= 0 && acceptance[i] > 0.6) {
				return createBuySignal(cleanData, i, `Low-entropy regime disrupted, acceptance flipped bullish (${acceptance[i].toFixed(2)})`);
			}
			if (acceptance[i - 1] >= 0 && acceptance[i] < -0.6) {
				return createSellSignal(cleanData, i, `Low-entropy regime disrupted, acceptance flipped bearish (${acceptance[i].toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "structureRank"] } };
