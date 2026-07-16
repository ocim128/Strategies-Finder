import { OHLCVData } from "../../types/strategies";
import { computePriceActionBarMetrics, PriceActionBarMetrics } from "./price-action-frequency-core";

type NullableSeries = (number | null)[];

const rollingStdDevCache = new WeakMap<number[], Map<number, NullableSeries>>();
const rollingZScoreCache = new WeakMap<number[], Map<string, NullableSeries>>();
const rollingMedianCache = new WeakMap<number[], Map<number, NullableSeries>>();
const rollingSkewnessCache = new WeakMap<number[], Map<number, NullableSeries>>();
const rollingMinMaxCache = new WeakMap<number[], Map<string, { min: NullableSeries; max: NullableSeries }>>();
const rollingEntropyCache = new WeakMap<number[], Map<string, NullableSeries>>();
const percentileRankCache = new WeakMap<number[], Map<number, NullableSeries>>();
const efficiencyRatioCache = new WeakMap<OHLCVData[], Map<number, NullableSeries>>();
const barMetricSeriesCache = new WeakMap<OHLCVData[], Map<BarMetricExtractor, number[]>>();
// Caches for the helpers below that previously rebuilt their output on every call.
// Keyed by the same input arrays other helpers in this file already memoize on;
// the inputs are stable across Finder iterations (extracted via memoized helpers),
// so caching is safe and the results are deterministic.
const streakCountCache = new WeakMap<number[], number[]>();
const rateOfChangeCache = new WeakMap<number[], Map<number, NullableSeries>>();
const cumulativeDecaySumCache = new WeakMap<number[], Map<number, number[]>>();
const thresholdCrossingCountCache = new WeakMap<number[], Map<string, NullableSeries>>();
const rollingAutoCorrelationCache = new WeakMap<number[], Map<string, NullableSeries>>();
const rollingCorrelationCache = new WeakMap<number[], Map<number[], Map<string, NullableSeries>>>();
const rollingKurtosisCache = new WeakMap<number[], Map<number, NullableSeries>>();

function getCachedSeries<K>(
	cache: WeakMap<number[], Map<K, NullableSeries>>,
	values: number[],
	key: K,
	build: () => NullableSeries
): NullableSeries {
	let byKey = cache.get(values);
	if (!byKey) {
		byKey = new Map<K, NullableSeries>();
		cache.set(values, byKey);
	}
	const cached = byKey.get(key);
	if (cached) return cached;
	const result = build();
	byKey.set(key, result);
	return result;
}

function getCachedOhlcvSeries<K>(
	cache: WeakMap<OHLCVData[], Map<K, NullableSeries>>,
	data: OHLCVData[],
	key: K,
	build: () => NullableSeries
): NullableSeries {
	let byKey = cache.get(data);
	if (!byKey) {
		byKey = new Map<K, NullableSeries>();
		cache.set(data, byKey);
	}
	const cached = byKey.get(key);
	if (cached) return cached;
	const result = build();
	byKey.set(key, result);
	return result;
}

// ============================================================================
// Statistical Helpers for Strategy Diversity
// ============================================================================

/**
 * Rolling standard deviation over a fixed lookback window.
 * Works on any numeric series (body%, wick ratio, close location, etc.).
 * Uses population stddev (N divisor) for consistency.
 */
export function buildRollingStdDev(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	return getCachedSeries(rollingStdDevCache, values, lookback, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		let sum = 0;
		let sumSquares = 0;

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			sum += value;
			sumSquares += value * value;

			if (i >= lookback) {
				const removed = values[i - lookback];
				sum -= removed;
				sumSquares -= removed * removed;
			}
			if (i < lookback - 1) continue;
			const mean = sum / lookback;
			const variance = Math.max(0, (sumSquares / lookback) - (mean * mean));
			result[i] = Math.sqrt(variance);
		}

		return result;
	});
}

/**
 * Rolling z-score: (current value - rolling mean) / rolling stddev.
 * Returns null when stddev is zero or lookback not yet filled.
 */
export function buildRollingZScore(
	values: number[],
	lookbackInput: number,
	minStdDev = 1e-9
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	const stdDevFloor = Math.max(minStdDev, 1e-12);
	return getCachedSeries(rollingZScoreCache, values, `${lookback}|${stdDevFloor}`, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		let sum = 0;
		let sumSquares = 0;

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			sum += value;
			sumSquares += value * value;

			if (i >= lookback) {
				const removed = values[i - lookback];
				sum -= removed;
				sumSquares -= removed * removed;
			}
			if (i < lookback - 1) continue;
			const mean = sum / lookback;
			const variance = Math.max(0, (sumSquares / lookback) - (mean * mean));
			const stddev = Math.max(Math.sqrt(variance), stdDevFloor);
			result[i] = (value - mean) / stddev;
		}

		return result;
	});
}

/**
 * Rolling percentile rank of the current value within its lookback window.
 * Returns a value in [0, 1] where 1 means the current value is the highest
 * in the window and 0 means it is the lowest.
 */
export function buildPercentileRank(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	return getCachedSeries(percentileRankCache, values, lookback, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		const window: number[] = [];
		const lowerBound = (value: number): number => {
			let low = 0;
			let high = window.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (window[mid] < value) low = mid + 1;
				else high = mid;
			}
			return low;
		};

		for (let i = 0; i < values.length; i++) {
			const current = values[i];
			if (Number.isFinite(current)) {
				window.splice(lowerBound(current), 0, current);
			}

			if (i >= lookback) {
				const removed = values[i - lookback];
				if (Number.isFinite(removed)) {
					window.splice(lowerBound(removed), 1);
				}
			}

			if (i < lookback - 1 || !Number.isFinite(current) || window.length < 2) continue;
			result[i] = lowerBound(current) / (window.length - 1);
		}

		return result;
	});
}

/**
 * Counts consecutive events where `flags[i]` is true (non-zero).
 * Resets to 0 when `flags[i]` is 0 or falsy.
 * Positive values indicate bullish streak (+1,+2,...), negative for bearish (-1,-2,...).
 * Sign follows the sign of the flag value.
 */
export function buildStreakCount(
	flags: number[]
): number[] {
	const cached = streakCountCache.get(flags);
	if (cached) return cached;
	const result: number[] = new Array(flags.length).fill(0);

	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === 0) {
			result[i] = 0;
			continue;
		}

		const sign = flags[i] > 0 ? 1 : -1;
		if (i === 0) {
			result[i] = sign;
			continue;
		}

		// Continue streak if same sign, otherwise start new
		const prevSign = result[i - 1] > 0 ? 1 : result[i - 1] < 0 ? -1 : 0;
		if (prevSign === sign) {
			result[i] = result[i - 1] + sign;
		} else {
			result[i] = sign;
		}
	}

	streakCountCache.set(flags, result);
	return result;
}

/**
 * Rate of change of a numeric series over `period` bars.
 * ROC = (current - past) / |past|.  Returns null when past is zero or lookback not filled.
 */
export function buildRateOfChange(
	values: number[],
	periodInput: number
): (number | null)[] {
	const period = Math.max(1, Math.round(periodInput));
	return getCachedSeries(rateOfChangeCache, values, period, () => {
		const result: (number | null)[] = new Array(values.length).fill(null);

		for (let i = period; i < values.length; i++) {
			const past = values[i - period];
			if (past === 0) continue;
			result[i] = (values[i] - past) / Math.abs(past);
		}

		return result;
	});
}

/**
 * Kaufman-style efficiency ratio over a lookback window.
 * ER = |net price change| / sum of |bar-to-bar changes|.
 * 1 = perfectly directional, 0 = completely choppy.
 * Uses close prices from the OHLCV data.
 */
export function buildEfficiencyRatio(
	data: OHLCVData[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	return getCachedOhlcvSeries(efficiencyRatioCache, data, lookback, () => {
		const result: NullableSeries = new Array(data.length).fill(null);
		let sumAbsChanges = 0;

		for (let i = 1; i < data.length; i++) {
			sumAbsChanges += Math.abs(data[i].close - data[i - 1].close);
			if (i > lookback) {
				sumAbsChanges -= Math.abs(data[i - lookback].close - data[i - lookback - 1].close);
			}
			if (i < lookback || sumAbsChanges <= 0) continue;

			const netChange = Math.abs(data[i].close - data[i - lookback].close);
			result[i] = netChange / sumAbsChanges;
		}

		return result;
	});
}

/**
 * Rolling skewness of a numeric series.
 * Positive skew = long right tail (bullish outliers), negative = left tail (bearish outliers).
 * Uses sample skewness formula.
 */
export function buildRollingSkewness(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(3, Math.round(lookbackInput));
	return getCachedSeries(rollingSkewnessCache, values, lookback, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		const anchor = Number.isFinite(values[0]) ? values[0] : 0;
		let sum = 0;
		let sumSquares = 0;
		let sumCubes = 0;

		for (let i = 0; i < values.length; i++) {
			const value = values[i] - anchor;
			const squared = value * value;
			sum += value;
			sumSquares += squared;
			sumCubes += squared * value;

			if (i >= lookback) {
				const removed = values[i - lookback] - anchor;
				const removedSquared = removed * removed;
				sum -= removed;
				sumSquares -= removedSquared;
				sumCubes -= removedSquared * removed;
			}

			if (i < lookback - 1) continue;

			const mean = sum / lookback;
			const meanSquares = sumSquares / lookback;
			const variance = meanSquares - mean * mean;
			if (!Number.isFinite(variance) || variance <= 0) continue;

			const stddev = Math.sqrt(variance);
			const m3 = (sumCubes / lookback) - (3 * mean * meanSquares) + (2 * mean * mean * mean);
			result[i] = m3 / (stddev * stddev * stddev);
		}

		return result;
	});
}

/**
 * Exponentially decaying cumulative sum.
 * Each bar: accum = accum * decayFactor + score[i].
 * decayFactor in (0, 1) controls memory â€” 0.9 = long memory, 0.5 = fast decay.
 * Alternative to flat rolling average for score accumulation.
 */
export function buildCumulativeDecaySum(
	scores: number[],
	decayFactor: number
): number[] {
	const decay = Math.max(0.01, Math.min(0.999, decayFactor));
	let byDecay = cumulativeDecaySumCache.get(scores);
	if (!byDecay) {
		byDecay = new Map<number, number[]>();
		cumulativeDecaySumCache.set(scores, byDecay);
	}
	const cached = byDecay.get(decay);
	if (cached) return cached;

	const result: number[] = new Array(scores.length).fill(0);
	let accum = 0;

	for (let i = 0; i < scores.length; i++) {
		accum = accum * decay + scores[i];
		result[i] = accum;
	}

	byDecay.set(decay, result);
	return result;
}

/**
 * Rolling threshold crossing counter.
 * Counts how many times a series crosses through +threshold or -threshold
 * over the lookback window. With threshold = 0 this becomes a zero-line
 * crossing count, useful for measuring whipsaw around a reference level.
 */
export function buildThresholdCrossingCount(
	values: number[],
	lookbackInput: number,
	threshold: number
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	const absThreshold = Math.abs(threshold);
	const key = `${lookback}|${absThreshold}`;
	return getCachedSeries(thresholdCrossingCountCache, values, key, () => {
		const result: (number | null)[] = new Array(values.length).fill(null);
		const crossingEvents: number[] = new Array(values.length).fill(0);

		for (let i = 1; i < values.length; i++) {
			const prev = values[i - 1];
			const curr = values[i];
			const crossedUp = prev <= absThreshold && curr > absThreshold;
			const crossedDown = prev >= -absThreshold && curr < -absThreshold;
			crossingEvents[i] = crossedUp || crossedDown ? 1 : 0;
		}

		for (let i = lookback - 1; i < values.length; i++) {
			let count = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				count += crossingEvents[j];
			}
			result[i] = count;
		}

		return result;
	});
}

/**
 * Rolling median over a fixed lookback window.
 * Robust to outliers â€” useful as an alternative center-of-gravity to mean.
 * Maintains a sorted sliding window to avoid rebuilding the full window per bar.
 */
export function buildRollingMedian(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(1, Math.round(lookbackInput));
	return getCachedSeries(rollingMedianCache, values, lookback, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		const window: number[] = [];
		const lowerBound = (value: number): number => {
			let low = 0;
			let high = window.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (window[mid] < value) low = mid + 1;
				else high = mid;
			}
			return low;
		};

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			window.splice(lowerBound(value), 0, value);

			if (i >= lookback) {
				const removed = values[i - lookback];
				window.splice(lowerBound(removed), 1);
			}
			if (i < lookback - 1) continue;

			const mid = lookback >> 1;
			result[i] = (lookback & 1) ? window[mid] : (window[mid - 1] + window[mid]) / 2;
		}

		return result;
	});
}

export function buildRollingMinMax(
	values: number[],
	lookbackInput: number,
	includeCurrent = true
): { min: (number | null)[]; max: (number | null)[] } {
	const lookback = Math.max(1, Math.round(lookbackInput));
	const key = `${lookback}|${includeCurrent ? 1 : 0}`;
	let byKey = rollingMinMaxCache.get(values);
	if (!byKey) {
		byKey = new Map();
		rollingMinMaxCache.set(values, byKey);
	}
	const cached = byKey.get(key);
	if (cached) return cached;

	const min: NullableSeries = new Array(values.length).fill(null);
	const max: NullableSeries = new Array(values.length).fill(null);
	const minDeque: number[] = [];
	const maxDeque: number[] = [];
	let nextIndexToAdd = 0;

	const addIndex = (index: number): void => {
		const value = values[index];
		while (minDeque.length > 0 && values[minDeque[minDeque.length - 1]] >= value) minDeque.pop();
		minDeque.push(index);
		while (maxDeque.length > 0 && values[maxDeque[maxDeque.length - 1]] <= value) maxDeque.pop();
		maxDeque.push(index);
	};

	for (let i = 0; i < values.length; i++) {
		const end = includeCurrent ? i : i - 1;
		while (nextIndexToAdd <= end) {
			addIndex(nextIndexToAdd);
			nextIndexToAdd++;
		}

		const start = end - lookback + 1;
		while (minDeque.length > 0 && minDeque[0] < start) minDeque.shift();
		while (maxDeque.length > 0 && maxDeque[0] < start) maxDeque.shift();

		if (start < 0 || end < 0 || minDeque.length === 0 || maxDeque.length === 0) continue;
		min[i] = values[minDeque[0]];
		max[i] = values[maxDeque[0]];
	}

	const result = { min, max };
	byKey.set(key, result);
	return result;
}

/**
 * Rolling autocorrelation at a given lag.
 * Measures serial dependence: positive = trending, negative = mean-reverting.
 * Default lag is 1 (adjacent bar correlation).
 */
export function buildRollingAutoCorrelation(
	values: number[],
	lookbackInput: number,
	lag = 1
): (number | null)[] {
	const lookback = Math.max(3, Math.round(lookbackInput));
	const safeLag = Math.max(1, Math.round(lag));
	const key = `${lookback}|${safeLag}`;
	return getCachedSeries(rollingAutoCorrelationCache, values, key, () => {
		const result: (number | null)[] = new Array(values.length).fill(null);
		const firstEnd = lookback - 1 + safeLag;
		if (firstEnd >= values.length) return result;

		let sumX = 0;
		let sumY = 0;
		let sumXX = 0;
		let sumYY = 0;
		let sumXY = 0;
		let nonFinitePairs = 0;
		for (let yIndex = safeLag; yIndex <= firstEnd; yIndex++) {
			const x = values[yIndex - safeLag];
			const y = values[yIndex];
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				nonFinitePairs += 1;
				continue;
			}
			sumX += x;
			sumY += y;
			sumXX += x * x;
			sumYY += y * y;
			sumXY += x * y;
		}

		for (let i = firstEnd; i < values.length; i++) {
			if (nonFinitePairs > 0) {
				result[i] = Number.NaN;
			} else {
				const covariance = sumXY - ((sumX * sumY) / lookback);
				const varianceX = Math.max(0, sumXX - ((sumX * sumX) / lookback));
				const varianceY = Math.max(0, sumYY - ((sumY * sumY) / lookback));
				const denom = Math.sqrt(varianceX * varianceY);
				if (denom > 0) result[i] = covariance / denom;
			}

			const nextYIndex = i + 1;
			if (nextYIndex >= values.length) continue;
			const removedYIndex = nextYIndex - lookback;
			const removedX = values[removedYIndex - safeLag];
			const removedY = values[removedYIndex];
			const addedX = values[nextYIndex - safeLag];
			const addedY = values[nextYIndex];
			if (Number.isFinite(removedX) && Number.isFinite(removedY)) {
				sumX -= removedX;
				sumY -= removedY;
				sumXX -= removedX * removedX;
				sumYY -= removedY * removedY;
				sumXY -= removedX * removedY;
			} else {
				nonFinitePairs -= 1;
			}
			if (Number.isFinite(addedX) && Number.isFinite(addedY)) {
				sumX += addedX;
				sumY += addedY;
				sumXX += addedX * addedX;
				sumYY += addedY * addedY;
				sumXY += addedX * addedY;
			} else {
				nonFinitePairs += 1;
			}
		}

		return result;
	});
}

/**
 * Rolling correlation between two numeric series.
 * Measures linear relationship: +1 = perfect positive, -1 = perfect negative, 0 = no correlation.
 */
export function buildRollingCorrelation(
	series1: number[],
	series2: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(3, Math.round(lookbackInput));
	let bySeries2 = rollingCorrelationCache.get(series1);
	if (!bySeries2) {
		bySeries2 = new Map<number[], Map<string, NullableSeries>>();
		rollingCorrelationCache.set(series1, bySeries2);
	}
	let byKey = bySeries2.get(series2);
	if (!byKey) {
		byKey = new Map<string, NullableSeries>();
		bySeries2.set(series2, byKey);
	}
	const cached = byKey.get(`${lookback}`);
	if (cached) return cached;

	const len = Math.min(series1.length, series2.length);
	const result: (number | null)[] = new Array(len).fill(null);

	for (let i = lookback - 1; i < len; i++) {
		let sumX = 0;
		let sumY = 0;
		const n = lookback;

		for (let j = 0; j < n; j++) {
			const idx = i - n + 1 + j;
			sumX += series1[idx];
			sumY += series2[idx];
		}
		const meanX = sumX / n;
		const meanY = sumY / n;

		let cov = 0;
		let varX = 0;
		let varY = 0;
		for (let j = 0; j < n; j++) {
			const idx = i - n + 1 + j;
			const dx = series1[idx] - meanX;
			const dy = series2[idx] - meanY;
			cov += dx * dy;
			varX += dx * dx;
			varY += dy * dy;
		}

		const denom = Math.sqrt(varX * varY);
		if (denom <= 0) continue;
		result[i] = cov / denom;
	}

	byKey.set(`${lookback}`, result);
	return result;
}

/**
 * Rolling Shannon entropy of a discretized numeric series.
 * Bins values into `numBins` equal-width buckets over the rolling window.
 * Low entropy = concentrated/predictable, high entropy = disordered/random.
 */
export function buildRollingEntropy(
	values: number[],
	lookbackInput: number,
	numBins = 5
): (number | null)[] {
	const lookback = Math.max(3, Math.round(lookbackInput));
	const bins = Math.max(2, Math.round(numBins));
	return getCachedSeries(rollingEntropyCache, values, `${lookback}|${bins}`, () => {
		const result: NullableSeries = new Array(values.length).fill(null);
		const minDeque: number[] = [];
		const maxDeque: number[] = [];
		const counts = new Array<number>(bins).fill(0);
		let minHead = 0;
		let maxHead = 0;

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			while (minDeque.length > minHead && values[minDeque[minDeque.length - 1]] >= value) {
				minDeque.pop();
			}
			minDeque.push(i);
			while (maxDeque.length > maxHead && values[maxDeque[maxDeque.length - 1]] <= value) {
				maxDeque.pop();
			}
			maxDeque.push(i);

			const windowStart = i - lookback + 1;
			while (minDeque.length > minHead && minDeque[minHead] < windowStart) minHead++;
			while (maxDeque.length > maxHead && maxDeque[maxHead] < windowStart) maxHead++;

			if (i < lookback - 1) continue;
			const wMin = values[minDeque[minHead]];
			const wMax = values[maxDeque[maxHead]];
			const wRange = wMax - wMin;
			if (wRange <= 0) {
				result[i] = 0; // all identical -> zero entropy
				continue;
			}

			counts.fill(0);
			for (let j = i - lookback + 1; j <= i; j++) {
				let bin = Math.floor(((values[j] - wMin) / wRange) * bins);
				if (bin >= bins) bin = bins - 1; // clamp max edge
				counts[bin]++;
			}

			let entropy = 0;
			for (let b = 0; b < bins; b++) {
				if (counts[b] === 0) continue;
				const p = counts[b] / lookback;
				entropy -= p * Math.log2(p);
			}
			result[i] = entropy;
		}

		return result;
	});
}

/**
 * Extracts a per-bar numeric series from OHLCV data using bar metrics.
 * Useful for feeding any metric into statistical helpers without
 * recomputing bar metrics in every strategy.
 */
export type BarMetricExtractor =
	| "bodyPct"
	| "closeLocation"
	| "upperWick"
	| "lowerWick"
	| "range"
	| "body"
	| "bodyMid"
	| "wickImbalance"     // (lowerWick - upperWick) / range
	| "bodyMidDelta"      // bodyMid[i] - bodyMid[i-1], normalized by range
	| "closeReturn"       // (close[i] - close[i-1]) / close[i-1]
	| "gapPct"            // (open[i] - close[i-1]) / close[i-1]
	| "trueRange"         // max(H-L, |H-prevC|, |L-prevC|)
	| "bodyDirection"     // +1 bullish, -1 bearish, 0 doji
	| "closeMidpointDev"; // (close - midpoint) / range

export function extractBarMetricSeries(
	data: OHLCVData[],
	metric: BarMetricExtractor
): number[] {
	let byMetric = barMetricSeriesCache.get(data);
	if (!byMetric) {
		byMetric = new Map<BarMetricExtractor, number[]>();
		barMetricSeriesCache.set(data, byMetric);
	}
	const cached = byMetric.get(metric);
	if (cached) return cached;

	const result: number[] = new Array(data.length).fill(0);
	let prevM: PriceActionBarMetrics | null = null;

	for (let i = 0; i < data.length; i++) {
		const m = computePriceActionBarMetrics(data[i]);

		switch (metric) {
			case "bodyPct":
				result[i] = m.bodyPct;
				break;
			case "closeLocation":
				result[i] = m.closeLocation;
				break;
			case "upperWick":
				result[i] = m.upperWick;
				break;
			case "lowerWick":
				result[i] = m.lowerWick;
				break;
			case "range":
				result[i] = m.range;
				break;
			case "body":
				result[i] = m.body;
				break;
			case "bodyMid":
				result[i] = m.bodyMid;
				break;
			case "wickImbalance":
				result[i] = m.range > 0 ? (m.lowerWick - m.upperWick) / m.range : 0;
				break;
			case "bodyMidDelta":
				if (i === 0 || prevM === null) {
					result[i] = 0;
				} else {
					const avgRange = (m.range + prevM.range) / 2;
					result[i] = avgRange > 0 ? (m.bodyMid - prevM.bodyMid) / avgRange : 0;
				}
				break;
			case "closeReturn":
				if (i === 0 || data[i - 1].close === 0) {
					result[i] = 0;
				} else {
					result[i] = (data[i].close - data[i - 1].close) / data[i - 1].close;
				}
				break;
			case "gapPct":
				if (i === 0 || data[i - 1].close === 0) {
					result[i] = 0;
				} else {
					result[i] = (data[i].open - data[i - 1].close) / data[i - 1].close;
				}
				break;
			case "trueRange": {
				if (i === 0) {
					result[i] = m.range;
				} else {
					const prevClose = data[i - 1].close;
					result[i] = Math.max(
						m.range,
						Math.abs(data[i].high - prevClose),
						Math.abs(data[i].low - prevClose)
					);
				}
				break;
			}
			case "bodyDirection":
				result[i] = data[i].close > data[i].open ? 1 : data[i].close < data[i].open ? -1 : 0;
				break;
			case "closeMidpointDev":
				result[i] = m.range > 0 ? (data[i].close - m.midpoint) / m.range : 0;
				break;
		}
		prevM = m;
	}

	byMetric.set(metric, result);
	return result;
}

/**
 * Rolling excess kurtosis of a numeric series.
 * High kurtosis indicates fat tails (extreme outliers).
 * Returns excess kurtosis: (m4 / (m2 * m2)) - 3.
 */
export function buildRollingKurtosis(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(4, Math.round(lookbackInput));
	return getCachedSeries(rollingKurtosisCache, values, lookback, () => {
		const result: (number | null)[] = new Array(values.length).fill(null);

		for (let i = lookback - 1; i < values.length; i++) {
			let sum = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				sum += values[j];
			}
			const mean = sum / lookback;

			let m2 = 0;
			let m4 = 0;
			for (let j = i - lookback + 1; j <= i; j++) {
				const diff = values[j] - mean;
				const diffSq = diff * diff;
				m2 += diffSq;
				m4 += diffSq * diffSq;
			}
			m2 /= lookback;
			m4 /= lookback;

			if (m2 <= 0) continue;

			result[i] = m4 / (m2 * m2) - 3;
		}

		return result;
	});
}


