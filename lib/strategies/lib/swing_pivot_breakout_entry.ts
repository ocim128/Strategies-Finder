import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, detectPivots, Pivot } from "../strategy-helpers";

function normalizeSwingPivotBreakoutEntryParams(params: StrategyParams): StrategyParams {
	const pivotDepth = Math.max(2, Math.round(params.pivotDepth ?? 5));
	const deviationPct = Math.max(0.1, Number(params.deviationPct ?? 1.0));
	return { ...params, pivotDepth, deviationPct };
}

export const swing_pivot_breakout_entry: Strategy = {
	name: "Swing Pivot Breakout Entry",
	description:
		"Confirmed swing highs and lows from detectPivots create structural price boundaries. When price breaks above the most recent confirmed swing high, resistance has failed and the path of least resistance is upward (and vice versa). This is the simplest possible structural breakout — no indicators, no derived series, just price vs its own confirmed turning points.",
	defaultParams: { pivotDepth: 5, deviationPct: 1.0 },
	paramLabels: { pivotDepth: "Pivot Depth", deviationPct: "Deviation (%)" },
	normalizeParams: normalizeSwingPivotBreakoutEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeSwingPivotBreakoutEntryParams(params);
		if (cleanData.length < np.pivotDepth * 2 + 3) return [];
		const closes = getCloses(cleanData);
		const pivots = detectPivots(cleanData, {
			depth: np.pivotDepth,
			deviationThreshold: np.deviationPct,
			extremaMode: "pine",
			lockConfirmedPivots: true }).sort((a: Pivot, b: Pivot) => a.index - b.index);
		const lastPivotHigh: (number | null)[] = new Array(cleanData.length).fill(null);
		const lastPivotLow: (number | null)[] = new Array(cleanData.length).fill(null);
		let curHigh: number | null = null;
		let curLow: number | null = null;
		let pIdx = 0;
		for (let i = 0; i < cleanData.length; i++) {
			while (pIdx < pivots.length && pivots[pIdx].index < i) {
				const p = pivots[pIdx];
				if (p.isHigh) curHigh = p.price;
				else curLow = p.price;
				pIdx++;
			}
			lastPivotHigh[i] = curHigh;
			lastPivotLow[i] = curLow;
		}
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			const ph = lastPivotHigh[i - 1];
			const pl = lastPivotLow[i - 1];
			if (ph !== null && closes[i - 1] <= ph && closes[i] > ph)
				signals.push(createBuySignal(cleanData, i, `Breakout above swing pivot high ${ph.toFixed(2)}`));
			if (pl !== null && closes[i - 1] >= pl && closes[i] < pl)
				signals.push(createSellSignal(cleanData, i, `Breakout below swing pivot low ${pl.toFixed(2)}`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["pivotDepth", "deviationPct"] } };
