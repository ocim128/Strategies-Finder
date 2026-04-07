import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeNarrowRangeBreakoutParams(params: StrategyParams): StrategyParams {
	const windowSize = Math.max(3, Math.round(params.windowSize ?? 7));
	return { ...params, windowSize };
}

export const narrow_range_breakout: Strategy = {
	name: "Narrow Range Breakout",
	description:
		"When a bar has the smallest true range of the last N bars (narrow range), the market has compressed to an unusual degree. The next bar that breaks this narrow bar's range releases stored energy. Toby Crabel's NR4/NR7 research showed narrow-range bars precede disproportionately large moves.",
	defaultParams: { windowSize: 7 },
	paramLabels: { windowSize: "Window Size" },
	normalizeParams: normalizeNarrowRangeBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeNarrowRangeBreakoutParams(params);
		if (cleanData.length < np.windowSize + 2) return [];
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = np.windowSize; i < cleanData.length; i++) {
			const prevTR = trueRange[i - 1];
			let isNarrowest = true;
			for (let j = i - np.windowSize; j < i; j++) {
				if (trueRange[j] < prevTR) {
					isNarrowest = false;
					break;
				}
			}
			if (!isNarrowest) continue;
			if (closes[i] > highs[i - 1])
				signals.push(createBuySignal(cleanData, i, `Narrow range breakout above ${highs[i - 1].toFixed(2)}`));
			else if (closes[i] < lows[i - 1])
				signals.push(createSellSignal(cleanData, i, `Narrow range breakout below ${lows[i - 1].toFixed(2)}`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["windowSize"] } };
