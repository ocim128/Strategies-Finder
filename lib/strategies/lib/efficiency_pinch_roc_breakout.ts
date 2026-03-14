import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { clamp } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

function normalizeEfficiencyPinchRocBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		compressionMax: clamp(params.compressionMax ?? 0.25, 0, 1),
		rocExpansionTarget: Math.max(0, params.rocExpansionTarget ?? 1.5),
	};
}

export const efficiency_pinch_roc_breakout: Strategy = {
	name: "Efficiency Pinch ROC Breakout",
	description: "Waits for a fully compressed low-efficiency state, then triggers when directional ROC breaks out of that dead tape.",
	defaultParams: {
		lookback: 14,
		compressionMax: 0.25,
		rocExpansionTarget: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		compressionMax: "Compression Max",
		rocExpansionTarget: "ROC Expansion Target (%)",
	},
	normalizeParams: normalizeEfficiencyPinchRocBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 14));
		const compressionMax = clamp(params.compressionMax ?? 0.25, 0, 1);
		const rocExpansionTarget = Math.max(0, params.rocExpansionTarget ?? 1.5);
		const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
		const rocPct = buildRateOfChange(getCloses(cleanData), lookback).map((value) =>
			value === null ? null : value * 100
		);

		return createSignalLoop(cleanData, [efficiencyRatio, rocPct], (i) => {
			const priorEr = efficiencyRatio[i - 1] as number;
			const rocValue = rocPct[i] as number;
			if (priorEr > compressionMax) return null;

			if (rocValue >= rocExpansionTarget) {
				return createBuySignal(cleanData, i, "Efficiency pinch bullish ROC breakout");
			}

			if (rocValue <= -rocExpansionTarget) {
				return createSellSignal(cleanData, i, "Efficiency pinch bearish ROC breakout");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "compressionMax", "rocExpansionTarget"],
	},
};
