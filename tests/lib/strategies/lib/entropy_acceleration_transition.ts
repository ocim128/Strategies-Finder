import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEntropyAccelerationTransitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 20)),
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 5)) };
}

export const entropy_acceleration_transition: Strategy = {
	name: "Entropy Acceleration Transition",
	description: "The rate of change of rolling entropy measures how fast the market's information structure is changing. When entropy ROC crosses from positive to negative, the market transitions from disordering to structuring. Enter in the direction of close versus rolling median.",
	defaultParams: {
		entropyWindow: 20,
		rocPeriod: 5 },
	paramLabels: {
		entropyWindow: "Entropy Window",
		rocPeriod: "ROC Period" },
	normalizeParams: normalizeEntropyAccelerationTransitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyAccelerationTransitionParams(params);
		const entropyWindow = p.entropyWindow as number;
		const rocPeriod = p.rocPeriod as number;
		if (cleanData.length < entropyWindow + rocPeriod + 2) return [];

		const closes = getCloses(cleanData);
		const returns: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			returns[i] = closes[i] - closes[i - 1];
		}

		const entropy = buildRollingEntropy(returns, entropyWindow);
		const entropyClean = entropy.map(v => v ?? 0);
		const entropyRoc = buildRateOfChange(entropyClean, rocPeriod);
		const medianClose = buildRollingMedian(closes, entropyWindow);

		return createSignalLoop(cleanData, [entropyRoc, medianClose], (i) => {
			if (i < entropyWindow + rocPeriod + 1) return null;
			const prevRoc = entropyRoc[i - 1];
			const currRoc = entropyRoc[i];
			if (prevRoc === null || currRoc === null) return null;

			if (prevRoc > 0 && currRoc <= 0) {
				const median = medianClose[i];
				if (median === null) return null;

				if (closes[i] > median) {
					return createBuySignal(cleanData, i, `Entropy ROC structuring transition (disorderingâ†’ordering), close above median`);
				}
				if (closes[i] < median) {
					return createSellSignal(cleanData, i, `Entropy ROC structuring transition (disorderingâ†’ordering), close below median`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "rocPeriod"] } };





