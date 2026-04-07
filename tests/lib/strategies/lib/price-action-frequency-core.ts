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
			bodyMid };
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
		bodyMid };
}

function buildMetricSeries(
	data: OHLCVData[],
	getValue: (bar: OHLCVData, metrics: PriceActionBarMetrics) => number
): number[] {
	const result: number[] = new Array(data.length);

	for (let i = 0; i < data.length; i++) {
		const bar = data[i];
		result[i] = getValue(bar, getPriceActionBarMetrics(bar));
	}

	return result;
}

export function buildRangeSeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.range);
}

export function buildBodySeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.body);
}

export function buildBodyPctSeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.bodyPct);
}

export function buildUpperWickSeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.upperWick);
}

export function buildLowerWickSeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.lowerWick);
}

export function buildCloseLocationSeries(data: OHLCVData[]): number[] {
	return buildMetricSeries(data, (_bar, metrics) => metrics.closeLocation);
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

export type BarMetricType = 'gapPct' | 'closeReturn' | 'bodyDirection' | 'bodyPct' | 'wickImbalance' | 'bodyMidDelta' | 'closeMidpointDev' | 'trueRange';

export function extractBarMetricSeries(data: OHLCVData[], metricType: BarMetricType): number[] {
	const result = new Array(data.length).fill(0);
	for (let i = 0; i < data.length; i++) {
		const bar = data[i];
		const prev = i > 0 ? data[i - 1] : bar;
		
		switch (metricType) {
			case 'gapPct':
				result[i] = i > 0 ? (bar.open - prev.close) / prev.close : 0;
				break;
			case 'closeReturn':
				result[i] = i > 0 ? (bar.close - prev.close) / prev.close : 0;
				break;
			case 'bodyDirection':
				result[i] = bar.close > bar.open ? 1 : (bar.close < bar.open ? -1 : 0);
				break;
			case 'bodyPct': {
				const range = bar.high - bar.low;
				result[i] = range === 0 ? 0 : Math.abs(bar.close - bar.open) / range;
				break;
			}
			case 'wickImbalance': {
				const range = bar.high - bar.low;
				if (range === 0) {
					result[i] = 0;
				} else {
					const bodyHigh = Math.max(bar.open, bar.close);
					const bodyLow = Math.min(bar.open, bar.close);
					const upperWick = bar.high - bodyHigh;
					const lowerWick = bodyLow - bar.low;
					result[i] = (lowerWick - upperWick) / range;
				}
				break;
			}
			case 'bodyMidDelta': {
				if (i === 0) {
					result[i] = 0;
				} else {
					const curMid = (Math.max(bar.open, bar.close) + Math.min(bar.open, bar.close)) / 2;
					const prevMid = (Math.max(prev.open, prev.close) + Math.min(prev.open, prev.close)) / 2;
					result[i] = curMid - prevMid;
				}
				break;
			}
			case 'closeMidpointDev': {
				const range = bar.high - bar.low;
				const midpoint = (bar.high + bar.low) / 2;
				result[i] = range === 0 ? 0 : (bar.close - midpoint) / range;
				break;
			}
			case 'trueRange':
				if (i === 0) {
					result[i] = bar.high - bar.low;
				} else {
					result[i] = Math.max(
						bar.high - bar.low,
						Math.abs(bar.high - prev.close),
						Math.abs(bar.low - prev.close)
					);
				}
				break;
		}
	}
	return result;
}
