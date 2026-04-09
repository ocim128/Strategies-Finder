import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, detectPivots } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizePivotRangeCompressionBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivotLookback: Math.max(2, Math.round(params.pivotLookback ?? 10)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 15))) };
}

export const pivot_range_compression_break: Strategy = {
	name: "Pivot Range Compression Break",
	description: "The distance between the most recent pivot high and low defines the structural negotiation range. When this range compresses to a percentile low, the market has converged. A close breaking beyond either pivot signals structural escape.",
	defaultParams: {
		pivotLookback: 10,
		compressionRank: 15 },
	paramLabels: {
		pivotLookback: "Pivot Lookback",
		compressionRank: "Compression Rank Max" },
	normalizeParams: normalizePivotRangeCompressionBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePivotRangeCompressionBreakParams(params);
		const lookback = p.pivotLookback as number;
		const rankMax = p.compressionRank as number;
		if (cleanData.length < lookback * 2 + 2) return [];

		const closes = getCloses(cleanData);
		const pivots = detectPivots(cleanData, {
			depth: lookback,
			deviationThreshold: 0.5,
			extremaMode: 'pine',
			includeConfirmationIndex: true,
			lockConfirmedPivots: true
		});

		const pivotRanges: number[] = new Array(cleanData.length).fill(Number.NaN);
		const pivotHighs: (number | null)[] = new Array(cleanData.length).fill(null);
		const pivotLows: (number | null)[] = new Array(cleanData.length).fill(null);

		let ph: number | null = null;
		let pl: number | null = null;
		let pivotIndex = 0;

		for (let i = 0; i < cleanData.length; i++) {
			while (pivotIndex < pivots.length) {
				const pv = pivots[pivotIndex];
				const activationIndex = pv.confirmationIndex ?? pv.index;
				if (activationIndex > i) {
					break;
				}
				if (pv.isHigh) ph = pv.price;
				else pl = pv.price;
				pivotIndex++;
			}

			pivotHighs[i] = ph;
			pivotLows[i] = pl;
			if (ph !== null && pl !== null) {
				pivotRanges[i] = Math.abs(ph - pl);
			}
		}

		const rank = buildPercentileRank(pivotRanges, lookback * 2);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < lookback * 2) return null;
			const r = rank[i];
			const hi = pivotHighs[i];
			const lo = pivotLows[i];
			if (r === null || hi === null || lo === null) return null;
			if (r >= rankMax / 100) return null;

			if (closes[i] > hi) {
				return createBuySignal(cleanData, i, `Pivot range compressed (rank ${(r * 100).toFixed(0)}%), close broke above pivot high ${hi.toFixed(2)}`);
			}
			if (closes[i] < lo) {
				return createSellSignal(cleanData, i, `Pivot range compressed (rank ${(r * 100).toFixed(0)}%), close broke below pivot low ${lo.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivotLookback", "compressionRank"] } };
