import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeAsymmetricCloseAcceptanceDriftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		acceptance_thresh: Math.max(0.51, Math.min(0.99, Number(params.acceptance_thresh ?? 0.65))) };
}

export const asymmetric_close_acceptance_drift: Strategy = {
	name: "Asymmetric Close Acceptance Drift",
	description: "When smoothed Close Acceptance stays elevated while price drops, hidden limit order absorption is catching falling knives — a structural divergence favoring reversal.",
	defaultParams: {
		lookback: 14,
		acceptance_thresh: 0.65 },
	paramLabels: {
		lookback: "Lookback",
		acceptance_thresh: "Acceptance Threshold" },
	normalizeParams: normalizeAsymmetricCloseAcceptanceDriftParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAsymmetricCloseAcceptanceDriftParams(params);
		if (cleanData.length < p.lookback) return [];

		const acceptance = buildCloseAcceptanceSeries(cleanData);
		const smoothed = buildRollingAverage(acceptance, p.lookback);
		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, p.lookback);

		return createSignalLoop(cleanData, [smoothed, roc], (i) => {
			if (i < p.lookback) return null;
			const avg = smoothed[i];
			const rocVal = roc[i];
			if (avg === null || rocVal === null) return null;

			if (avg > p.acceptance_thresh && rocVal < 0) {
				return createBuySignal(cleanData, i, `Acceptance ${avg.toFixed(3)} > ${p.acceptance_thresh} while ROC ${rocVal.toFixed(4)} < 0, hidden absorption`);
			}
			if (avg < (1 - p.acceptance_thresh) && rocVal > 0) {
				return createSellSignal(cleanData, i, `Acceptance ${avg.toFixed(3)} < ${1 - p.acceptance_thresh} while ROC ${rocVal.toFixed(4)} > 0, hidden absorption`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "acceptance_thresh"] } };
