import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeBarOverlapExhaustionParams(params: StrategyParams): StrategyParams {
	const minNoOverlap = Math.min(6, Math.max(2, Math.round(params.minNoOverlap ?? 3)));
	return { ...params, minNoOverlap };
}

export const bar_overlap_exhaustion: Strategy = {
	name: "Bar Overlap Exhaustion",
	description:
		"Bar overlap measures how much consecutive bars share common price territory. When overlap drops to zero for N consecutive bars, the market is moving without any pullback — pure directional urgency. After N consecutive non-overlapping bars, exhaustion is likely and a fade entry captures the inevitable pause.",
	defaultParams: { minNoOverlap: 3 },
	paramLabels: { minNoOverlap: "Min No-Overlap Bars" },
	normalizeParams: normalizeBarOverlapExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeBarOverlapExhaustionParams(params);
		if (cleanData.length < np.minNoOverlap + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const upNoOverlap: number[] = new Array(cleanData.length).fill(0);
		const downNoOverlap: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			if (lows[i] > highs[i - 1]) upNoOverlap[i] = 1;
			else if (highs[i] < lows[i - 1]) downNoOverlap[i] = 1;
		}
		const upStreaks = buildStreakCount(upNoOverlap);
		const downStreaks = buildStreakCount(downNoOverlap);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			if (downStreaks[i - 1] >= np.minNoOverlap && closes[i] > closes[i - 1])
				signals.push(createBuySignal(cleanData, i, `Fade after ${downStreaks[i - 1]}-bar downward no-overlap exhaustion`));
			if (upStreaks[i - 1] >= np.minNoOverlap && closes[i] < closes[i - 1])
				signals.push(createSellSignal(cleanData, i, `Fade after ${upStreaks[i - 1]}-bar upward no-overlap exhaustion`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["minNoOverlap"] } };
