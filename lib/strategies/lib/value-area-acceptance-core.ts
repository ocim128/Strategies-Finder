import { OHLCVData } from "../../types/strategies";
import { ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";

// ============================================================================
// Value-Area Acceptance & Migration Core
//
// Market-Profile-inspired primitives using only OHLCV data.
// Answers "where does price spend its time?" via TPO-style histogram bins.
//
// All functions are causal: bar i sees only data[0..i].
// ============================================================================

export interface ValueAreaFrame {
	/** Value Area High — upper boundary of the acceptance zone */
	vah: number;
	/** Value Area Low — lower boundary of the acceptance zone */
	val: number;
	/** Point of Control — most-visited price level (mode bin midpoint) */
	poc: number;
}

export type NullableSeries = (number | null)[];

/**
 * Builds per-bar rolling Value Area (VAH, VAL, POC) from close prices.
 *
 * Uses equal-width histogram bins over the trailing [high, low] range.
 * POC = midpoint of the bin with the most closes.
 * VA = smallest contiguous set of bins around POC that cover >= coveragePct
 * of the window's bars.
 *
 * @param data       Clean OHLCV data
 * @param lookback   Rolling window size (bars)
 * @param coveragePct Fraction of bars the VA must cover, default 0.68 (~1σ)
 * @param numBins    Histogram resolution, default 12
 */
export function buildRollingValueArea(
	data: OHLCVData[],
	lookbackInput: number,
	coveragePct = 0.68,
	numBins = 12
): { vah: NullableSeries; val: NullableSeries; poc: NullableSeries } {
	const lookback = Math.max(3, Math.round(lookbackInput));
	const bins = Math.max(3, Math.round(numBins));
	const coverage = Math.max(0.1, Math.min(0.99, coveragePct));
	const len = data.length;

	const vah: NullableSeries = new Array(len).fill(null);
	const val: NullableSeries = new Array(len).fill(null);
	const poc: NullableSeries = new Array(len).fill(null);

	const closes = getCloses(data);
	const highs = getHighs(data);
	const lows = getLows(data);

	// Reusable bin-count array to avoid per-bar allocation
	const counts = new Array(bins);

	for (let i = lookback - 1; i < len; i++) {
		const start = i - lookback + 1;

		// Find trailing high/low for bin edges
		let wHigh = -Infinity;
		let wLow = Infinity;
		for (let j = start; j <= i; j++) {
			if (highs[j] > wHigh) wHigh = highs[j];
			if (lows[j] < wLow) wLow = lows[j];
		}

		const wRange = wHigh - wLow;
		if (wRange <= 0) {
			// Flat window — POC is the price, VA collapses to a point
			poc[i] = closes[i];
			vah[i] = closes[i];
			val[i] = closes[i];
			continue;
		}

		// Histogram: bucket closes into equal-width bins
		for (let b = 0; b < bins; b++) counts[b] = 0;

		for (let j = start; j <= i; j++) {
			let bin = Math.floor(((closes[j] - wLow) / wRange) * bins);
			if (bin >= bins) bin = bins - 1;
			counts[bin]++;
		}

		// POC = bin with highest count
		let pocBin = 0;
		let maxCount = counts[0];
		for (let b = 1; b < bins; b++) {
			if (counts[b] > maxCount) {
				maxCount = counts[b];
				pocBin = b;
			}
		}

		const binWidth = wRange / bins;
		poc[i] = wLow + (pocBin + 0.5) * binWidth;

		// Expand outward from POC bin until coverage threshold is met
		const targetCount = Math.ceil(lookback * coverage);
		let coveredCount = counts[pocBin];
		let lo = pocBin;
		let hi = pocBin;

		while (coveredCount < targetCount && (lo > 0 || hi < bins - 1)) {
			const canGoLo = lo > 0;
			const canGoHi = hi < bins - 1;

			if (canGoLo && canGoHi) {
				// Expand toward whichever neighbor has more count
				if (counts[lo - 1] >= counts[hi + 1]) {
					lo--;
					coveredCount += counts[lo];
				} else {
					hi++;
					coveredCount += counts[hi];
				}
			} else if (canGoLo) {
				lo--;
				coveredCount += counts[lo];
			} else {
				hi++;
				coveredCount += counts[hi];
			}
		}

		val[i] = wLow + lo * binWidth;
		vah[i] = wLow + (hi + 1) * binWidth;
	}

	return { vah, val, poc };
}

/**
 * Fraction of recent bars whose close fell inside [VAL, VAH].
 *
 * High acceptance rate = balanced / range-bound market.
 * Low acceptance rate  = initiative / trending move in progress.
 *
 * Uses a secondary rolling window (acceptLookback) over the VA series
 * to count how many recent bars settled inside the value area.
 *
 * @param closes           Close price array
 * @param vah              Value Area High series (from buildRollingValueArea)
 * @param val              Value Area Low series (from buildRollingValueArea)
 * @param acceptLookback   How many recent bars to check for acceptance
 */
export function buildValueAreaAcceptanceRate(
	closes: number[],
	vah: NullableSeries,
	val: NullableSeries,
	acceptLookbackInput: number
): NullableSeries {
	const acceptLookback = Math.max(2, Math.round(acceptLookbackInput));
	const len = closes.length;
	const result: NullableSeries = new Array(len).fill(null);

	for (let i = acceptLookback - 1; i < len; i++) {
		// Need a valid VA at bar i to define the zone
		const curVah = vah[i];
		const curVal = val[i];
		if (curVah === null || curVal === null) continue;

		let insideCount = 0;
		let validCount = 0;
		for (let j = i - acceptLookback + 1; j <= i; j++) {
			validCount++;
			if (closes[j] >= curVal && closes[j] <= curVah) {
				insideCount++;
			}
		}
		if (validCount < 2) continue;
		result[i] = insideCount / validCount;
	}

	return result;
}

/**
 * Normalized VA width: (VAH - VAL) / close.
 *
 * Narrow = compressed / consolidation.
 * Wide   = explored range / expanded distribution.
 *
 * Useful as a compression-vs-expansion gauge that combines naturally
 * with entropy or efficiency-ratio filters.
 */
export function buildValueAreaWidth(
	vah: NullableSeries,
	val: NullableSeries,
	closes: number[]
): NullableSeries {
	const len = Math.min(vah.length, val.length, closes.length);
	const result: NullableSeries = new Array(len).fill(null);

	for (let i = 0; i < len; i++) {
		const h = vah[i];
		const l = val[i];
		if (h === null || l === null || closes[i] <= 0) continue;
		result[i] = (h - l) / closes[i];
	}

	return result;
}

/**
 * Rate of POC drift over a lookback window.
 *
 * Nonzero = distribution center is migrating (trending).
 * Zero    = distribution center is anchored (mean-reverting).
 *
 * Returned as normalized change: (poc[i] - poc[i - period]) / close[i].
 * Sign indicates drift direction.
 */
export function buildValueAreaMigrationRate(
	poc: NullableSeries,
	closes: number[],
	periodInput: number
): NullableSeries {
	const period = Math.max(1, Math.round(periodInput));
	const len = Math.min(poc.length, closes.length);
	const result: NullableSeries = new Array(len).fill(null);

	for (let i = period; i < len; i++) {
		const cur = poc[i];
		const prev = poc[i - period];
		if (cur === null || prev === null || closes[i] <= 0) continue;
		result[i] = (cur - prev) / closes[i];
	}

	return result;
}

/**
 * Price position relative to the Value Area.
 *
 *  0  = at POC (distribution center)
 * +1  = at VAH (upper acceptance boundary)
 * -1  = at VAL (lower acceptance boundary)
 * >+1 = above VAH (excess / initiative buying)
 * <-1 = below VAL (excess / initiative selling)
 *
 * This is the primary directional input for value-area strategies.
 * It maps price into a distribution-relative coordinate system
 * that is independent of absolute price level or volatility.
 */
export function buildPricePositionInVA(
	closes: number[],
	vah: NullableSeries,
	val: NullableSeries,
	poc: NullableSeries
): NullableSeries {
	const len = Math.min(closes.length, vah.length, val.length, poc.length);
	const result: NullableSeries = new Array(len).fill(null);

	for (let i = 0; i < len; i++) {
		const h = vah[i];
		const l = val[i];
		const p = poc[i];
		if (h === null || l === null || p === null) continue;

		const halfWidth = (h - l) / 2;
		if (halfWidth <= 0) {
			// Collapsed VA — position is just distance from POC
			result[i] = 0;
			continue;
		}

		// Center on POC, normalize by half-width so ±1 = VA boundary
		result[i] = (closes[i] - p) / halfWidth;
	}

	return result;
}

/**
 * Value Area Rotation: are both VA boundaries shifting in the same
 * direction (migration), apart (expansion), or together (contraction)?
 *
 * Returns a two-component object per bar:
 * - `shift`: signed mean boundary movement, normalized by close.
 *            Positive = upward migration, negative = downward.
 * - `spread`: change in VA width over the period, normalized by close.
 *             Positive = expansion, negative = contraction.
 *
 * For strategy authors who want a single scalar, `shift` alone
 * often suffices. `spread` adds a compression/expansion dimension.
 */
export function buildValueAreaRotation(
	vah: NullableSeries,
	val: NullableSeries,
	closes: number[],
	periodInput: number
): { shift: NullableSeries; spread: NullableSeries } {
	const period = Math.max(1, Math.round(periodInput));
	const len = Math.min(vah.length, val.length, closes.length);
	const shift: NullableSeries = new Array(len).fill(null);
	const spread: NullableSeries = new Array(len).fill(null);

	for (let i = period; i < len; i++) {
		const curH = vah[i];
		const curL = val[i];
		const prevH = vah[i - period];
		const prevL = val[i - period];
		if (
			curH === null || curL === null ||
			prevH === null || prevL === null ||
			closes[i] <= 0
		) continue;

		const deltaH = curH - prevH;
		const deltaL = curL - prevL;

		// Mean boundary shift — both moving same direction = migration
		shift[i] = ((deltaH + deltaL) / 2) / closes[i];

		// Width change — expanding apart or contracting together
		const curWidth = curH - curL;
		const prevWidth = prevH - prevL;
		spread[i] = (curWidth - prevWidth) / closes[i];
	}

	return { shift, spread };
}

// ============================================================================
// Finder-ready prepared data pattern (matches range-conviction-core.ts)
// ============================================================================

export interface ValueAreaPreparedData {
	cleanData: OHLCVData[];
	closes: number[];
	highs: number[];
	lows: number[];
	/** Memoized VA computations keyed by "lookback:bins" */
	vaCache: Map<string, { vah: NullableSeries; val: NullableSeries; poc: NullableSeries }>;
}

/**
 * Pre-build shared arrays for Finder hot loops.
 * VA series are memoized by (lookback, bins) key to avoid
 * redundant recomputation across param sweeps.
 */
export function prepareValueAreaData(data: OHLCVData[]): ValueAreaPreparedData {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		closes: getCloses(cleanData),
		highs: getHighs(cleanData),
		lows: getLows(cleanData),
		vaCache: new Map(),
	};
}

/**
 * Type-guard accessor: use existing prepared data or rebuild.
 */
export function getPreparedValueAreaData(
	preparedData: unknown,
	data: OHLCVData[]
): ValueAreaPreparedData {
	if (
		preparedData
		&& typeof preparedData === "object"
		&& "vaCache" in preparedData
		&& "cleanData" in preparedData
	) {
		return preparedData as ValueAreaPreparedData;
	}
	return prepareValueAreaData(data);
}

/**
 * Memoized VA series accessor for Finder param sweeps.
 * Reuses previously computed VA for the same (lookback, bins) pair.
 */
export function getValueAreaSeries(
	prepared: ValueAreaPreparedData,
	lookback: number,
	coveragePct = 0.68,
	numBins = 12
): { vah: NullableSeries; val: NullableSeries; poc: NullableSeries } {
	const key = `${lookback}:${numBins}:${coveragePct}`;
	let cached = prepared.vaCache.get(key);
	if (!cached) {
		cached = buildRollingValueArea(prepared.cleanData, lookback, coveragePct, numBins);
		prepared.vaCache.set(key, cached);
	}
	return cached;
}
