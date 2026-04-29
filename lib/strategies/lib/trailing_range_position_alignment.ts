import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeTrailingRangePositionAlignmentParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(2, Math.round(Number(params.lookback ?? 55)));
	const positionThreshold = Math.max(0.01, Math.min(0.99, Number(params.position_threshold ?? 0.65)));
	return {
		...params,
		lookback,
		position_threshold: positionThreshold };
}

export const trailing_range_position_alignment: Strategy = {
	name: "Trailing Range Position Alignment",
	description: "Computes the current close position as a fraction inside the trailing high-low range and signals when price is in the upper or lower portion of its recent multi-month envelope.",
	defaultParams: {
		lookback: 55,
		position_threshold: 0.65 },
	paramLabels: {
		lookback: "Lookback",
		position_threshold: "Position Threshold" },
	normalizeParams: normalizeTrailingRangePositionAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingRangePositionAlignmentParams(params);
		const lookback = p.lookback as number;
		const posThreshold = p.position_threshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const { min, max } = buildRollingMinMax(closes, lookback);

		return createSignalLoop(cleanData, [min, max], (i) => {
			const lo = min[i];
			const hi = max[i];
			if (lo === null || hi === null) return null;

			const range = hi - lo;
			if (range <= 0) return null;

			const position = (closes[i] - lo) / range;

			if (position > posThreshold) {
				return createBuySignal(cleanData, i, `Range position ${(position * 100).toFixed(1)}% above threshold ${(posThreshold * 100).toFixed(0)}%`);
			}
			if (position < (1 - posThreshold)) {
				return createSellSignal(cleanData, i, `Range position ${(position * 100).toFixed(1)}% below ${((1 - posThreshold) * 100).toFixed(0)}%`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "position_threshold"] } };
