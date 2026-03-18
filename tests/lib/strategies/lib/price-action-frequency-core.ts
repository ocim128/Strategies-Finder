import { OHLCVData } from "../../types/strategies";

export interface PriceActionBarMetrics {
	range: number;
	body: number;
	upperWick: number;
	lowerWick: number;
	bodyPct: number;
	closeLocation: number;
	midpoint: number;
	bodyHigh: number;
	bodyLow: number;
	bodyMid: number;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function getPriceActionBarMetrics(bar: OHLCVData): PriceActionBarMetrics {
	const range = Math.max(0, bar.high - bar.low);
	const bodyHigh = Math.max(bar.open, bar.close);
	const bodyLow = Math.min(bar.open, bar.close);
	const body = bodyHigh - bodyLow;
	const upperWick = Math.max(0, bar.high - bodyHigh);
	const lowerWick = Math.max(0, bodyLow - bar.low);
	const midpoint = (bar.high + bar.low) / 2;
	const bodyMid = (bodyHigh + bodyLow) / 2;

	if (range <= 0) {
		return {
			range: 0,
			body,
			upperWick: 0,
			lowerWick: 0,
			bodyPct: 0,
			closeLocation: 0.5,
			midpoint,
			bodyHigh,
			bodyLow,
			bodyMid,
		};
	}

	return {
		range,
		body,
		upperWick,
		lowerWick,
		bodyPct: clamp(body / range, 0, 1),
		closeLocation: clamp((bar.close - bar.low) / range, 0, 1),
		midpoint,
		bodyHigh,
		bodyLow,
		bodyMid,
	};
}

export function buildRollingAverage(
	values: number[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(1, Math.round(lookbackInput));
	const result: (number | null)[] = new Array(values.length).fill(null);
	let sum = 0;

	for (let i = 0; i < values.length; i++) {
		sum += values[i];
		if (i >= lookback) {
			sum -= values[i - lookback];
		}
		if (i >= lookback - 1) {
			result[i] = sum / lookback;
		}
	}

	return result;
}

export function buildTrailingAverageRange(
	data: OHLCVData[],
	lookbackInput: number,
	includeCurrent = false
): (number | null)[] {
	const lookback = Math.max(1, Math.round(lookbackInput));
	const result: (number | null)[] = new Array(data.length).fill(null);
	let sum = 0;

	for (let i = 0; i < data.length; i++) {
		const range = Math.max(0, data[i].high - data[i].low);
		sum += range;

		if (includeCurrent) {
			if (i >= lookback) {
				sum -= Math.max(0, data[i - lookback].high - data[i - lookback].low);
			}
			if (i >= lookback - 1) {
				result[i] = sum / lookback;
			}
			continue;
		}

		if (i >= lookback) {
			result[i] = (sum - range) / lookback;
			sum -= Math.max(0, data[i - lookback].high - data[i - lookback].low);
		}
	}

	return result;
}

export function buildTrailingHighLow(
	data: OHLCVData[],
	lookbackInput: number,
	includeCurrent = false
): { highest: (number | null)[]; lowest: (number | null)[] } {
	const lookback = Math.max(1, Math.round(lookbackInput));
	const highest: (number | null)[] = new Array(data.length).fill(null);
	const lowest: (number | null)[] = new Array(data.length).fill(null);

	for (let i = 0; i < data.length; i++) {
		const end = includeCurrent ? i : i - 1;
		const start = end - lookback + 1;
		if (start < 0 || end < 0) {
			continue;
		}

		let hi = -Infinity;
		let lo = Infinity;
		for (let j = start; j <= end; j++) {
			if (data[j].high > hi) hi = data[j].high;
			if (data[j].low < lo) lo = data[j].low;
		}

		highest[i] = hi;
		lowest[i] = lo;
	}

	return { highest, lowest };
}

export function buildTrailingWindowSpan(
	data: OHLCVData[],
	lookbackInput: number,
	includeCurrent = false
): (number | null)[] {
	const { highest, lowest } = buildTrailingHighLow(data, lookbackInput, includeCurrent);
	const result: (number | null)[] = new Array(data.length).fill(null);

	for (let i = 0; i < data.length; i++) {
		const hi = highest[i];
		const lo = lowest[i];
		if (hi === null || lo === null) continue;
		result[i] = Math.max(0, hi - lo);
	}

	return result;
}
