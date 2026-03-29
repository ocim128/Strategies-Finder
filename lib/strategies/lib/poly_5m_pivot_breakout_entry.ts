import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizePoly5mPivotBreakoutEntryParams(params: StrategyParams): StrategyParams {
	const pivotLookback = Math.max(3, Math.round(params.pivotLookback ?? 12));
	const breakoutBars = Math.max(1, Math.round(params.breakoutBars ?? 2));
	const minRoc = Math.max(0, Number(params.minRoc ?? 0.15));

	return {
		...params,
		pivotLookback,
		breakoutBars,
		minRoc,
	};
}

export const poly_5m_pivot_breakout_entry: Strategy = {
	name: "Poly 5m Pivot Breakout Entry",
	description: "When price breaks through a recent pivot level with momentum, enter in breakout direction. Uses pivot detection with consecutive bar confirmation and rate of change filter.",
	defaultParams: {
		pivotLookback: 12,
		breakoutBars: 2,
		minRoc: 0.15,
	},
	paramLabels: {
		pivotLookback: "Pivot Lookback",
		breakoutBars: "Breakout Bars",
		minRoc: "Min ROC",
	},
	normalizeParams: normalizePoly5mPivotBreakoutEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizePoly5mPivotBreakoutEntryParams(params);
		const minBars = normalizedParams.pivotLookback + normalizedParams.breakoutBars + 3;
		if (cleanData.length < minBars) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const roc = buildRateOfChange(closes, 3);

		// Detect pivot highs and lows
		const pivotHighs: (number | null)[] = new Array(cleanData.length).fill(null);
		const pivotLows: (number | null)[] = new Array(cleanData.length).fill(null);
		const halfLookback = Math.floor(normalizedParams.pivotLookback / 2);

		for (let i = halfLookback; i < cleanData.length - halfLookback; i++) {
			let isHigh = true;
			let isLow = true;
			const currentHigh = highs[i];
			const currentLow = lows[i];

			for (let j = i - halfLookback; j <= i + halfLookback; j++) {
				if (j === i) continue;
				if (highs[j] >= currentHigh) isHigh = false;
				if (lows[j] <= currentLow) isLow = false;
			}

			if (isHigh) pivotHighs[i] = currentHigh;
			if (isLow) pivotLows[i] = currentLow;
		}

		// Track recent pivot levels
		const recentPivotHigh: (number | null)[] = new Array(cleanData.length).fill(null);
		const recentPivotLow: (number | null)[] = new Array(cleanData.length).fill(null);

		let lastPivotHigh: number | null = null;
		let lastPivotLow: number | null = null;

		for (let i = 0; i < cleanData.length; i++) {
			if (pivotHighs[i] !== null) lastPivotHigh = pivotHighs[i];
			if (pivotLows[i] !== null) lastPivotLow = pivotLows[i];
			recentPivotHigh[i] = lastPivotHigh;
			recentPivotLow[i] = lastPivotLow;
		}

		return createSignalLoop(cleanData, [recentPivotHigh, recentPivotLow, roc], (i) => {
			const pivotHigh = recentPivotHigh[i];
			const pivotLow = recentPivotLow[i];
			const currentRoc = roc[i];

			if (pivotHigh === null || pivotLow === null || currentRoc === null) return null;

			// Check for consecutive bars above pivot high
			let abovePivotCount = 0;
			for (let j = 0; j < normalizedParams.breakoutBars && (i - j) >= 0; j++) {
				if (closes[i - j] > pivotHigh) {
					abovePivotCount++;
				}
			}

			// Check for consecutive bars below pivot low
			let belowPivotCount = 0;
			for (let j = 0; j < normalizedParams.breakoutBars && (i - j) >= 0; j++) {
				if (closes[i - j] < pivotLow) {
					belowPivotCount++;
				}
			}

			// Buy signal: breakout above pivot high with momentum
			if (abovePivotCount >= normalizedParams.breakoutBars && currentRoc > normalizedParams.minRoc) {
				return createBuySignal(cleanData, i, `Breakout above pivot ${pivotHigh.toFixed(4)}, ROC: ${currentRoc.toFixed(4)}`);
			}

			// Sell signal: breakout below pivot low with momentum
			if (belowPivotCount >= normalizedParams.breakoutBars && currentRoc < -normalizedParams.minRoc) {
				return createSellSignal(cleanData, i, `Breakout below pivot ${pivotLow.toFixed(4)}, ROC: ${currentRoc.toFixed(4)}`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pivotLookback", "breakoutBars", "minRoc"],
	},
};
