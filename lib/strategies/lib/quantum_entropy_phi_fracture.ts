import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMedian } from "./price-action-statistics-core";

function normalizeQuantumEntropyPhiFractureParams(params: StrategyParams): StrategyParams {
	const entropyLookback = Math.max(5, Math.round(params.entropyLookback ?? 30));
	const goldenEntropyLimit = Math.max(0.01, Math.min(2, Number(params.goldenEntropyLimit ?? 0.618)));
	return { ...params, entropyLookback, goldenEntropyLimit };
}

export const quantum_entropy_phi_fracture: Strategy = {
	name: "Quantum Entropy Phi Fracture",
	description:
		"Enters when rolling information entropy collapses below the golden 0.618 threshold and price confirms directional intent via a median crossover, signaling synchronized algorithmic order flow.",
	defaultParams: { entropyLookback: 30, goldenEntropyLimit: 0.618 },
	paramLabels: { entropyLookback: "Entropy Lookback", goldenEntropyLimit: "Golden Entropy Limit" },
	normalizeParams: normalizeQuantumEntropyPhiFractureParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeQuantumEntropyPhiFractureParams(params);
		if (cleanData.length < np.entropyLookback + 2) return [];

		const closes = getCloses(cleanData);
		const returns = new Array(closes.length).fill(0);
		for (let i = 1; i < closes.length; i++) {
			returns[i] = closes[i] - closes[i - 1];
		}
		const entropy = buildRollingEntropy(returns, np.entropyLookback);
		const median = buildRollingMedian(closes, np.entropyLookback);

		const signals = [];
		for (let i = np.entropyLookback; i < cleanData.length; i++) {
			const e = entropy[i];
			const m = median[i];
			if (e === null || m === null) continue;

			if (e < np.goldenEntropyLimit && closes[i - 1] <= median[i - 1]! && closes[i] > m) {
				signals.push(createBuySignal(cleanData, i, `Entropy < ${np.goldenEntropyLimit} & close above median`));
			}
			if (e < np.goldenEntropyLimit && closes[i - 1] >= median[i - 1]! && closes[i] < m) {
				signals.push(createSellSignal(cleanData, i, `Entropy < ${np.goldenEntropyLimit} & close below median`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyLookback", "goldenEntropyLimit"],
	},
};
