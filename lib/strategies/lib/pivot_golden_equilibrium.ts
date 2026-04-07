import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, detectPivotsWithDeviation } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizePivotGoldenEquilibriumParams(params: StrategyParams): StrategyParams {
	const pivotDeviation = Math.max(0.1, Number(params.pivotDeviation ?? 2.0));
	return { ...params, pivotDeviation };
}

export const pivot_golden_equilibrium: Strategy = {
	name: "Pivot Golden Equilibrium",
	description:
		"A breakout algorithm that refuses to buy extended bars. It only buys the crossing of a major pivot if the breakout bar's close location is resting in a perfect 0.382 to 0.618 equilibrium.",
	defaultParams: { pivotDeviation: 2.0 },
	paramLabels: { pivotDeviation: "Pivot Deviation (%)" },
	normalizeParams: normalizePivotGoldenEquilibriumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizePivotGoldenEquilibriumParams(params);
		if (cleanData.length < 10) return [];
		const pivots = detectPivotsWithDeviation(cleanData, np.pivotDeviation, 10).sort((a, b) => a.index - b.index);
		const closeLoc = extractBarMetricSeries(cleanData, "closeLocation");
		const closes = getCloses(cleanData);
		const lastPivotHigh: (number | null)[] = new Array(cleanData.length).fill(null);
		const lastPivotLow: (number | null)[] = new Array(cleanData.length).fill(null);
		let curHigh: number | null = null;
		let curLow: number | null = null;
		let pIdx = 0;
		for (let i = 0; i < cleanData.length; i++) {
			while (pIdx < pivots.length && pivots[pIdx].index <= i) {
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
			const cl = closeLoc[i];
			if (cl <= 0.382 || cl >= 0.618) continue;
			if (ph !== null && closes[i - 1] <= ph && closes[i] > ph)
				signals.push(createBuySignal(cleanData, i, `Pivot high breakout at equilibrium, close location ${cl.toFixed(3)}`));
			if (pl !== null && closes[i - 1] >= pl && closes[i] < pl)
				signals.push(createSellSignal(cleanData, i, `Pivot low breakout at equilibrium, close location ${cl.toFixed(3)}`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["pivotDeviation"] } };
