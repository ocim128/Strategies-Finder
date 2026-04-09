import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEntropyCollapseDirectionalPushParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		entropy_max: Math.max(0.01, Number(params.entropy_max ?? 0.8)) };
}

export const entropy_collapse_directional_push: Strategy = {
	name: "Entropy Collapse Directional Push",
	description: "When rolling entropy collapses, the market is mathematically ordered. Entering in the direction of the dominant median slope during low entropy avoids noise.",
	defaultParams: {
		lookback: 20,
		entropy_max: 0.8 },
	paramLabels: {
		lookback: "Lookback",
		entropy_max: "Max Entropy" },
	normalizeParams: normalizeEntropyCollapseDirectionalPushParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEntropyCollapseDirectionalPushParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const entropy = buildRollingEntropy(closes, p.lookback);
		const median = buildRollingMedian(closes, p.lookback);

		return createSignalLoop(cleanData, [entropy, median], (i) => {
			if (i < 1 || i < p.lookback) return null;
			const ent = entropy[i];
			const medCurr = median[i];
			const medPrev = median[i - 1];
			if (ent === null || medCurr === null || medPrev === null) return null;

			if (ent < p.entropy_max && closes[i] > medCurr && medCurr > medPrev) {
				return createBuySignal(cleanData, i, `Entropy ${ent.toFixed(3)} < ${p.entropy_max}, close > median, median rising`);
			}
			if (ent < p.entropy_max && closes[i] < medCurr && medCurr < medPrev) {
				return createSellSignal(cleanData, i, `Entropy ${ent.toFixed(3)} < ${p.entropy_max}, close < median, median falling`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropy_max"] } };
