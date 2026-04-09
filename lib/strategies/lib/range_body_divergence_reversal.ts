import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRangeSeries, buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRangeBodyDivergenceReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		divergenceMargin: Math.max(0, Math.abs(Number(params.divergenceMargin ?? 0.3))) };
}

export const range_body_divergence_reversal: Strategy = {
	name: "Range-Body Divergence Reversal",
	description: "When total bar range is expanding while body fraction is shrinking, the market is churning — spending energy without conviction. This divergence at structural extremes identifies exhaustion of the prevailing direction.",
	defaultParams: {
		lookback: 20,
		divergenceMargin: 0.3 },
	paramLabels: {
		lookback: "Lookback",
		divergenceMargin: "Divergence Margin" },
	normalizeParams: normalizeRangeBodyDivergenceReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRangeBodyDivergenceReversalParams(params);
		const lookback = p.lookback as number;
		const margin = p.divergenceMargin as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const rangeSeries = buildRangeSeries(cleanData);
		const bodyPctSeries = buildBodyPctSeries(cleanData);
		const avgRange = buildRollingAverage(rangeSeries, lookback);
		const avgBodyPct = buildRollingAverage(bodyPctSeries, lookback);
		const medianClose = buildRollingMedian(closes, lookback);

		return createSignalLoop(cleanData, [avgRange, avgBodyPct, medianClose], (i) => {
			if (i < lookback) return null;
			const aRange = avgRange[i];
			const aBody = avgBodyPct[i];
			const median = medianClose[i];
			if (aRange === null || aRange <= 0 || aBody === null || aBody <= 0 || median === null) return null;

			const rangeRatio = rangeSeries[i] / aRange;
			const bodyRatio = bodyPctSeries[i] / aBody;

			if (rangeRatio > (1 + margin) && bodyRatio < (1 - margin)) {
				if (closes[i] < median) {
					return createBuySignal(cleanData, i, `Range-body divergence (range ${rangeRatio.toFixed(2)}x, body ${bodyRatio.toFixed(2)}x), close below median`);
				}
				if (closes[i] > median) {
					return createSellSignal(cleanData, i, `Range-body divergence (range ${rangeRatio.toFixed(2)}x, body ${bodyRatio.toFixed(2)}x), close above median`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "divergenceMargin"] } };
