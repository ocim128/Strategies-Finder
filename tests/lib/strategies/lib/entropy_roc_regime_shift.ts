import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRateOfChange } from "./price-action-statistics-core";

function normalizeEntropyRocRegimeShiftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 20)),
		rocWindow: Math.max(1, Math.round(params.rocWindow ?? 5)) };
}

export const entropy_roc_regime_shift: Strategy = {
	name: "Entropy ROC Regime Shift",
	description: "When entropy's rate-of-change flips from negative (compressing) to positive (expanding), a structural regime transition is underway. Enter in the direction of the new regime's momentum.",
	defaultParams: {
		entropyWindow: 20,
		rocWindow: 5 },
	paramLabels: {
		entropyWindow: "Entropy Window",
		rocWindow: "ROC Window" },
	normalizeParams: normalizeEntropyRocRegimeShiftParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyRocRegimeShiftParams(params);
		if (cleanData.length < p.entropyWindow + p.rocWindow) return [];

		const closes = getCloses(cleanData);
		const entropy = buildRollingEntropy(closes, p.entropyWindow);
		const entropyValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			entropyValues[i] = entropy[i] ?? 0;
		}
		const entropyRoc = buildRateOfChange(entropyValues, p.rocWindow);

		return createSignalLoop(cleanData, [entropyRoc], (i) => {
			if (i < 1 || i < p.entropyWindow + p.rocWindow) return null;
			const rocCurr = entropyRoc[i];
			const rocPrev = entropyRoc[i - 1];
			if (rocCurr === null || rocPrev === null) return null;

			if (rocPrev < 0 && rocCurr >= 0 && closes[i] > closes[i - 1]) {
				return createBuySignal(cleanData, i, `Entropy ROC flipped positive: ${rocPrev.toFixed(4)} -> ${rocCurr.toFixed(4)}, upward momentum`);
			}
			if (rocPrev < 0 && rocCurr >= 0 && closes[i] < closes[i - 1]) {
				return createSellSignal(cleanData, i, `Entropy ROC flipped positive: ${rocPrev.toFixed(4)} -> ${rocCurr.toFixed(4)}, downward momentum`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "rocWindow"] } };
