import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingWindowSpan, buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeTrailingSpanInitiativeDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		divergenceThreshold: Math.max(0, Math.abs(Number(params.divergenceThreshold ?? 0.5))) };
}

export const trailing_span_initiative_divergence: Strategy = {
	name: "Trailing Span Initiative Divergence",
	description: "When trailing span expands but initiative pressure contracts, the market moves on structural gamma drift without aggressive participation. This divergence is unsustainable. Fade the drift direction because the drift will exhaust when dealer deltas neutralize.",
	defaultParams: {
		lookback: 20,
		divergenceThreshold: 0.5 },
	paramLabels: {
		lookback: "Lookback",
		divergenceThreshold: "Divergence Threshold" },
	normalizeParams: normalizeTrailingSpanInitiativeDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingSpanInitiativeDivergenceParams(params);
		const lookback = p.lookback as number;
		const divergenceThreshold = p.divergenceThreshold as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const span = buildTrailingWindowSpan(cleanData, lookback);
		const spanClean = span.map(v => v ?? 0);
		const spanROC = buildRateOfChange(spanClean, lookback);

		const ipSeries = buildInitiativePressureSeries(cleanData, lookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const ipAbs = ipClean.map(v => Math.abs(v));
		const ipAbsROC = buildRateOfChange(ipAbs, lookback);

		const avgClose = buildRollingAverage(closes, lookback);

		return createSignalLoop(cleanData, [spanROC, ipAbsROC, avgClose], (i) => {
			if (i < lookback + 1) return null;
			const sROC = spanROC[i];
			const iaROC = ipAbsROC[i];
			if (sROC === null || iaROC === null) return null;

			if (sROC > divergenceThreshold && iaROC < -divergenceThreshold) {
				const avg = avgClose[i];
				if (avg === null) return null;

				if (closes[i] < avg) {
					return createBuySignal(cleanData, i, `Span expanding (${(sROC * 100).toFixed(1)}%) with initiative contracting — fade downside drift`);
				}
				if (closes[i] > avg) {
					return createSellSignal(cleanData, i, `Span expanding (${(sROC * 100).toFixed(1)}%) with initiative contracting — fade upside drift`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "divergenceThreshold"] } };
