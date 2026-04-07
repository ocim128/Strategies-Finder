import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeBodyPctTrendTransitionParams(params: StrategyParams): StrategyParams {
	const smoothPeriod = Math.max(3, Math.round(params.smoothPeriod ?? 10));
	const commitmentThreshold = Math.min(0.85, Math.max(0.4, Number(params.commitmentThreshold ?? 0.6)));
	return { ...params, smoothPeriod, commitmentThreshold };
}

export const body_pct_trend_transition: Strategy = {
	name: "Body Pct Trend Transition",
	description:
		"Body percentage (body size / total range) measures directional commitment per bar. When the rolling average of body pct crosses above a threshold, bars are becoming consistently directional — informed participants are committing capital. Entering on the upward cross in the close direction captures the moment directional flow begins to dominate.",
	defaultParams: { smoothPeriod: 10, commitmentThreshold: 0.6 },
	paramLabels: { smoothPeriod: "Smooth Period", commitmentThreshold: "Commitment Threshold" },
	normalizeParams: normalizeBodyPctTrendTransitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeBodyPctTrendTransitionParams(params);
		if (cleanData.length < np.smoothPeriod + 2) return [];
		const closes = getCloses(cleanData);
		const bodyPct = buildBodyPctSeries(cleanData);
		const smoothed = buildRollingAverage(bodyPct, np.smoothPeriod);
		return createSignalLoop(cleanData, [smoothed], (i) => {
			const prev = smoothed[i - 1];
			const curr = smoothed[i];
			if (prev === null || curr === null) return null;
			if (prev < np.commitmentThreshold && curr >= np.commitmentThreshold) {
				if (closes[i] > closes[i - 1])
					return createBuySignal(cleanData, i, `Body pct commitment cross ${prev.toFixed(3)} -> ${curr.toFixed(3)}, bullish direction`);
				if (closes[i] < closes[i - 1])
					return createSellSignal(cleanData, i, `Body pct commitment cross ${prev.toFixed(3)} -> ${curr.toFixed(3)}, bearish direction`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["smoothPeriod", "commitmentThreshold"] } };
