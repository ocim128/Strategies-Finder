import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingSpanRangeBreakoutParams(params: StrategyParams): StrategyParams {
	const windowLookback = Math.max(2, Math.round(params.windowLookback ?? 20));
	const minSpan = Math.min(windowLookback, Math.max(1, Math.round(params.minSpan ?? 10)));
	return { ...params, windowLookback, minSpan };
}

export const trailing_span_range_breakout: Strategy = {
	name: "Trailing Span Range Breakout",
	description:
		"Measures the number of bars since the trailing window set its last high or low extreme. A long span indicates price has been rangebound (no new extremes). When price finally breaks out of this compressed range, the breakout carries structural significance because the market has been building a position equilibrium that is now resolving.",
	defaultParams: { windowLookback: 20, minSpan: 10 },
	paramLabels: { windowLookback: "Window Lookback", minSpan: "Min Span Bars" },
	normalizeParams: normalizeTrailingSpanRangeBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeTrailingSpanRangeBreakoutParams(params);
		if (cleanData.length < np.windowLookback + np.minSpan + 1) return [];
		const closes = getCloses(cleanData);
		const { highest, lowest } = buildTrailingHighLow(cleanData, np.windowLookback, true);
		const spanSinceHigh: number[] = new Array(cleanData.length).fill(0);
		const spanSinceLow: number[] = new Array(cleanData.length).fill(0);
		let barsSinceHigh = 0;
		let barsSinceLow = 0;
		let prevHigh: number | null = null;
		let prevLow: number | null = null;
		for (let i = 0; i < cleanData.length; i++) {
			const h = highest[i];
			const l = lowest[i];
			if (h !== null && l !== null) {
				if (prevHigh === null || h !== prevHigh) {
					barsSinceHigh = 0;
					prevHigh = h;
				} else {
					barsSinceHigh++;
				}
				if (prevLow === null || l !== prevLow) {
					barsSinceLow = 0;
					prevLow = l;
				} else {
					barsSinceLow++;
				}
			}
			spanSinceHigh[i] = barsSinceHigh;
			spanSinceLow[i] = barsSinceLow;
		}
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			const h = highest[i];
			const l = lowest[i];
			if (h === null || l === null) continue;
			if (spanSinceHigh[i] >= np.minSpan && closes[i] > h)
				signals.push(createBuySignal(cleanData, i, `Span ${spanSinceHigh[i]} bars since last low extreme, breakout above trailing high`));
			if (spanSinceLow[i] >= np.minSpan && closes[i] < l)
				signals.push(createSellSignal(cleanData, i, `Span ${spanSinceLow[i]} bars since last high extreme, breakout below trailing low`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["windowLookback", "minSpan"] } };
