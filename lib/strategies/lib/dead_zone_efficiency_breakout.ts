import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";
import { clamp } from "./price-action-frequency-core";

function normalizeDeadZoneEfficiencyBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		window: Math.max(2, Math.round(params.window ?? 14)),
		max_er_threshold: clamp(params.max_er_threshold ?? 0.2, 0, 1),
		roc_trigger: Math.max(0, params.roc_trigger ?? 1.5),
	};
}

export const dead_zone_efficiency_breakout: Strategy = {
	name: "Dead-Zone Efficiency Breakout",
	description: "Waits for a low-efficiency dead zone and only triggers when rate-of-change snaps out directionally.",
	defaultParams: {
		window: 14,
		max_er_threshold: 0.2,
		roc_trigger: 1.5,
	},
	paramLabels: {
		window: "Window",
		max_er_threshold: "Max ER Threshold",
		roc_trigger: "ROC Trigger (%)",
	},
	normalizeParams: normalizeDeadZoneEfficiencyBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const window = Math.max(2, Math.round(params.window ?? 14));
		const maxErThreshold = clamp(params.max_er_threshold ?? 0.2, 0, 1);
		const rocTrigger = Math.max(0, params.roc_trigger ?? 1.5);
		const efficiencyRatio = buildEfficiencyRatio(cleanData, window);
		const rocPct = buildRateOfChange(getCloses(cleanData), window).map((value) =>
			value === null ? null : value * 100
		);

		return createSignalLoop(cleanData, [efficiencyRatio, rocPct], (i) => {
			const priorEr = efficiencyRatio[i - 1] as number;
			const rocValue = rocPct[i] as number;
			if (priorEr > maxErThreshold) return null;

			if (rocValue >= rocTrigger) {
				return createBuySignal(cleanData, i, "Dead-zone efficiency bullish breakout");
			}
			if (rocValue <= -rocTrigger) {
				return createSellSignal(cleanData, i, "Dead-zone efficiency bearish breakout");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["window", "max_er_threshold", "roc_trigger"],
	},
};
