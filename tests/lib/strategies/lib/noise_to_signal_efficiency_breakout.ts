import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";
import { clamp } from "./price-action-frequency-core";

function normalizeNoiseToSignalParams(params: StrategyParams): StrategyParams {
	const erPeriod = Math.max(2, Math.round(params.erPeriod ?? 14));
	const rawChoppyThreshold = Number(params.choppyThreshold ?? 0.2);
	const choppyThreshold = clamp(Number.isFinite(rawChoppyThreshold) ? rawChoppyThreshold : 0.2, 0, 1);
	const rawRocThreshold = Number(params.rocThreshold ?? 1);
	const rocThreshold = Math.max(0, Number.isFinite(rawRocThreshold) ? rawRocThreshold : 1);

	return {
		...params,
		erPeriod,
		choppyThreshold,
		rocThreshold,
	};
}

export const noise_to_signal_efficiency_breakout: Strategy = {
	name: "Noise to Signal Efficiency Breakout",
	description: "Waits for a near-zero efficiency dead zone, then fires only when rate-of-change exits that noise regime with force.",
	defaultParams: {
		erPeriod: 14,
		choppyThreshold: 0.2,
		rocThreshold: 1,
	},
	paramLabels: {
		erPeriod: "ER Period",
		choppyThreshold: "Choppy Threshold",
		rocThreshold: "ROC Threshold (%)",
	},
	normalizeParams: normalizeNoiseToSignalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const normalizedParams = normalizeNoiseToSignalParams(params);
		const erPeriod = normalizedParams.erPeriod;
		const choppyThreshold = normalizedParams.choppyThreshold;
		const rocThreshold = normalizedParams.rocThreshold;
		const efficiencyRatio = buildEfficiencyRatio(cleanData, erPeriod);
		const rocPct = buildRateOfChange(getCloses(cleanData), erPeriod).map((value) =>
			value === null ? null : value * 100
		);

		return createSignalLoop(cleanData, [efficiencyRatio, rocPct], (i) => {
			const priorEr = efficiencyRatio[i - 1] as number;
			const rocValue = rocPct[i] as number;
			if (priorEr >= choppyThreshold) return null;

			if (rocValue >= rocThreshold) {
				return createBuySignal(cleanData, i, "Noise-to-signal bullish efficiency breakout");
			}

			if (rocValue <= -rocThreshold) {
				return createSellSignal(cleanData, i, "Noise-to-signal bearish efficiency breakout");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["erPeriod", "choppyThreshold", "rocThreshold"],
	},
};
