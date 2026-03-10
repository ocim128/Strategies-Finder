import { OHLCVData } from "../../types/strategies";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

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
	const result: (number | null)[] = new Array(values.length).fill(null);

	for (let i = lookback - 1; i < values.length; i++) {
		let sum = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			sum += values[j];
		}
		const mean = sum / lookback;

		let sumSqDiff = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			const diff = values[j] - mean;
			sumSqDiff += diff * diff;
		}
		result[i] = Math.sqrt(sumSqDiff / lookback);
	}

	return result;
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
	const result: (number | null)[] = new Array(values.length).fill(null);
	const varianceFloor = Math.max(minStdDev, 1e-12);

	for (let i = lookback - 1; i < values.length; i++) {
		let sum = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			sum += values[j];
		}
		const mean = sum / lookback;

		let sumSqDiff = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			const diff = values[j] - mean;
			sumSqDiff += diff * diff;
		}
		const stddev = Math.max(Math.sqrt(sumSqDiff / lookback), varianceFloor);
		result[i] = (values[i] - mean) / stddev;
	}

	return result;
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
	const result: (number | null)[] = new Array(values.length).fill(null);

	for (let i = lookback - 1; i < values.length; i++) {
		const current = values[i];
		if (!Number.isFinite(current)) continue;
		let countBelow = 0;
		let validCount = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			const sample = values[j];
			if (!Number.isFinite(sample)) continue;
			validCount++;
			if (sample < current) countBelow++;
		}
		if (validCount < 2) continue;
		result[i] = countBelow / (validCount - 1);
	}

	return result;
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
	const result: (number | null)[] = new Array(values.length).fill(null);

	for (let i = period; i < values.length; i++) {
		const past = values[i - period];
		if (past === 0) continue;
		result[i] = (values[i] - past) / Math.abs(past);
	}

	return result;
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
	const result: (number | null)[] = new Array(data.length).fill(null);

	for (let i = lookback; i < data.length; i++) {
		const netChange = Math.abs(data[i].close - data[i - lookback].close);

		let sumAbsChanges = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			sumAbsChanges += Math.abs(data[j].close - data[j - 1].close);
		}

		if (sumAbsChanges <= 0) continue;
		result[i] = netChange / sumAbsChanges;
	}

	return result;
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
	const result: (number | null)[] = new Array(values.length).fill(null);

	for (let i = lookback - 1; i < values.length; i++) {
		let sum = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			sum += values[j];
		}
		const mean = sum / lookback;

		let m2 = 0;
		let m3 = 0;
		for (let j = i - lookback + 1; j <= i; j++) {
			const diff = values[j] - mean;
			m2 += diff * diff;
			m3 += diff * diff * diff;
		}
		m2 /= lookback;
		m3 /= lookback;

		const stddev = Math.sqrt(m2);
		if (stddev <= 0) continue;

		result[i] = m3 / (stddev * stddev * stddev);
	}

	return result;
}

/**
 * Exponentially decaying cumulative sum.
 * Each bar: accum = accum * decayFactor + score[i].
 * decayFactor in (0, 1) controls memory — 0.9 = long memory, 0.5 = fast decay.
 * Alternative to flat rolling average for score accumulation.
 */
export function buildCumulativeDecaySum(
	scores: number[],
	decayFactor: number
): number[] {
	const decay = Math.max(0.01, Math.min(0.999, decayFactor));
	const result: number[] = new Array(scores.length).fill(0);
	let accum = 0;

	for (let i = 0; i < scores.length; i++) {
		accum = accum * decay + scores[i];
		result[i] = accum;
	}

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
}

/**
 * Extracts a per-bar numeric series from OHLCV data using bar metrics.
 * Useful for feeding any metric into statistical helpers without
 * recomputing `getPriceActionBarMetrics` in every strategy.
 */
export type BarMetricExtractor =
	| "bodyPct"
	| "closeLocation"
	| "upperWick"
	| "lowerWick"
	| "range"
	| "body"
	| "wickImbalance"     // (lowerWick - upperWick) / range
	| "bodyMidDelta"      // bodyMid[i] - bodyMid[i-1], normalized by range
	| "closeReturn";      // (close[i] - close[i-1]) / close[i-1]

export function extractBarMetricSeries(
	data: OHLCVData[],
	metric: BarMetricExtractor
): number[] {
	const result: number[] = new Array(data.length).fill(0);

	for (let i = 0; i < data.length; i++) {
		const m = getPriceActionBarMetrics(data[i]);

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
			case "wickImbalance":
				result[i] = m.range > 0 ? (m.lowerWick - m.upperWick) / m.range : 0;
				break;
			case "bodyMidDelta":
				if (i === 0) {
					result[i] = 0;
				} else {
					const prevM = getPriceActionBarMetrics(data[i - 1]);
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
		}
	}

	return result;
}
