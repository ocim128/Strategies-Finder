import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeDualRocSnapbackResumptionParams(params: StrategyParams): StrategyParams {
	const fast_lookback = Math.max(1, Math.round(params.fast_lookback ?? 5));
	const slow_lookback = Math.max(2, Math.round(params.slow_lookback ?? 40));
	return {
		...params,
		fast_lookback,
		slow_lookback: Math.max(slow_lookback, fast_lookback + 1),
		slow_roc_min: Math.max(0.01, Math.abs(Number(params.slow_roc_min ?? 2.0))) };
}

export const dual_roc_snapback_resumption: Strategy = {
	name: "Dual ROC Snapback Resumption",
	description: "When fast ROC crosses zero in the direction of a strongly trending slow ROC, the pullback has ended and trend resumption is signaled.",
	defaultParams: {
		fast_lookback: 5,
		slow_lookback: 40,
		slow_roc_min: 2.0 },
	paramLabels: {
		fast_lookback: "Fast Lookback",
		slow_lookback: "Slow Lookback",
		slow_roc_min: "Min Slow ROC" },
	normalizeParams: normalizeDualRocSnapbackResumptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualRocSnapbackResumptionParams(params);
		if (cleanData.length < p.slow_lookback) return [];

		const closes = getCloses(cleanData);
		const fastRoc = buildRateOfChange(closes, p.fast_lookback);
		const slowRoc = buildRateOfChange(closes, p.slow_lookback);

		return createSignalLoop(cleanData, [fastRoc, slowRoc], (i) => {
			if (i < 1 || i < p.slow_lookback) return null;
			const fCurr = fastRoc[i];
			const fPrev = fastRoc[i - 1];
			const s = slowRoc[i];
			if (fCurr === null || fPrev === null || s === null) return null;

			if (s > p.slow_roc_min && fPrev <= 0 && fCurr > 0) {
				return createBuySignal(cleanData, i, `Slow ROC ${s.toFixed(3)} > ${p.slow_roc_min}, fast ROC crossed above zero, resumption`);
			}
			if (s < -p.slow_roc_min && fPrev >= 0 && fCurr < 0) {
				return createSellSignal(cleanData, i, `Slow ROC ${s.toFixed(3)} < -${p.slow_roc_min}, fast ROC crossed below zero, resumption`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_lookback", "slow_lookback", "slow_roc_min"] } };
