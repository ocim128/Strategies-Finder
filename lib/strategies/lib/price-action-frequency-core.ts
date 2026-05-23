import { OHLCVData } from "../../types/strategies";

type NullableSeries = (number | null)[];

const rangeSeriesCache = new WeakMap<OHLCVData[], number[]>();
const bodyPctSeriesCache = new WeakMap<OHLCVData[], number[]>();
const closeLocationSeriesCache = new WeakMap<OHLCVData[], number[]>();
const closeAcceptanceSeriesCache = new WeakMap<OHLCVData[], number[]>();
const initiativePressureCache = new WeakMap<OHLCVData[], Map<number, NullableSeries>>();
const trailingHighLowCache = new WeakMap<OHLCVData[], Map<string, { highest: NullableSeries; lowest: NullableSeries }>>();

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

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function computePriceActionBarMetrics(bar: OHLCVData): PriceActionBarMetrics {
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
		result[i] = getValue(bar, computePriceActionBarMetrics(bar));
	}

	return result;
}

function getCachedMetricSeries(
	cache: WeakMap<OHLCVData[], number[]>,
	data: OHLCVData[],
	build: () => number[]
): number[] {
	const cached = cache.get(data);
	if (cached) return cached;
	const result = build();
	cache.set(data, result);
	return result;
}

export function buildRangeSeries(data: OHLCVData[]): number[] {
	return getCachedMetricSeries(rangeSeriesCache, data, () =>
		buildMetricSeries(data, (_bar, metrics) => metrics.range)
	);
}

export function buildBodyPctSeries(data: OHLCVData[]): number[] {
	return getCachedMetricSeries(bodyPctSeriesCache, data, () =>
		buildMetricSeries(data, (_bar, metrics) => metrics.bodyPct)
	);
}

export function buildCloseLocationSeries(data: OHLCVData[]): number[] {
	return getCachedMetricSeries(closeLocationSeriesCache, data, () =>
		buildMetricSeries(data, (_bar, metrics) => metrics.closeLocation)
	);
}

export function buildCloseAcceptanceSeries(data: OHLCVData[]): number[] {
	return getCachedMetricSeries(closeAcceptanceSeriesCache, data, () =>
		buildMetricSeries(data, (bar, metrics) => {
			if (metrics.range <= 0) return 0;
			const closeBias = metrics.closeLocation * 2 - 1;
			const directionalBody = (bar.close - bar.open) / metrics.range;
			return clamp((closeBias + directionalBody) / 2, -1, 1);
		})
	);
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

export function buildInitiativePressureSeries(
	data: OHLCVData[],
	lookbackInput: number
): (number | null)[] {
	const lookback = Math.max(2, Math.round(lookbackInput));
	let byLookback = initiativePressureCache.get(data);
	if (!byLookback) {
		byLookback = new Map<number, NullableSeries>();
		initiativePressureCache.set(data, byLookback);
	}
	const cached = byLookback.get(lookback);
	if (cached) return cached;

	const result: NullableSeries = new Array(data.length).fill(null);
	const closeAcceptance = buildCloseAcceptanceSeries(data);
	const avgVolumes = buildRollingAverage(data.map((bar) => Math.max(0, bar.volume)), lookback);

	for (let i = 0; i < data.length; i++) {
		const avgVolume = avgVolumes[i];
		if (avgVolume === null || avgVolume <= 0) continue;
		const relativeVolume = clamp(data[i].volume / avgVolume, 0, 3);
		result[i] = closeAcceptance[i] * relativeVolume;
	}

	byLookback.set(lookback, result);
	return result;
}

export function buildTrailingHighLow(
	data: OHLCVData[],
	lookbackInput: number,
	includeCurrent = false
): { highest: (number | null)[]; lowest: (number | null)[] } {
	const lookback = Math.max(1, Math.round(lookbackInput));
	const cacheKey = `${lookback}|${includeCurrent ? 1 : 0}`;
	let byKey = trailingHighLowCache.get(data);
	if (!byKey) {
		byKey = new Map<string, { highest: NullableSeries; lowest: NullableSeries }>();
		trailingHighLowCache.set(data, byKey);
	}
	const cached = byKey.get(cacheKey);
	if (cached) return cached;

	const highest: NullableSeries = new Array(data.length).fill(null);
	const lowest: NullableSeries = new Array(data.length).fill(null);
	const highDeque: number[] = [];
	const lowDeque: number[] = [];
	let nextIndexToAdd = 0;

	const addIndex = (index: number): void => {
		const high = data[index].high;
		const low = data[index].low;
		while (highDeque.length > 0 && data[highDeque[highDeque.length - 1]].high <= high) {
			highDeque.pop();
		}
		highDeque.push(index);
		while (lowDeque.length > 0 && data[lowDeque[lowDeque.length - 1]].low >= low) {
			lowDeque.pop();
		}
		lowDeque.push(index);
	};

	for (let i = 0; i < data.length; i++) {
		const end = includeCurrent ? i : i - 1;
		while (nextIndexToAdd <= end) {
			addIndex(nextIndexToAdd);
			nextIndexToAdd++;
		}

		const start = end - lookback + 1;
		while (highDeque.length > 0 && highDeque[0] < start) highDeque.shift();
		while (lowDeque.length > 0 && lowDeque[0] < start) lowDeque.shift();

		if (start < 0 || end < 0 || highDeque.length === 0 || lowDeque.length === 0) continue;
		highest[i] = data[highDeque[0]].high;
		lowest[i] = data[lowDeque[0]].low;
	}

	const result = { highest, lowest };
	byKey.set(cacheKey, result);

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

export function buildSweepReclaimSeries(
	data: OHLCVData[],
	lookbackInput: number
): { bullish: (number | null)[]; bearish: (number | null)[] } {
	const lookback = Math.max(2, Math.round(lookbackInput));
	const len = data.length;
	const bullish: (number | null)[] = new Array(len).fill(null);
	const bearish: (number | null)[] = new Array(len).fill(null);
	if (len < lookback + 1) return { bullish, bearish };

	for (let i = lookback; i < len; i++) {
		let lowestLow = Infinity;
		let highestHigh = -Infinity;
		for (let j = i - lookback; j < i; j++) {
			if (data[j].low < lowestLow) lowestLow = data[j].low;
			if (data[j].high > highestHigh) highestHigh = data[j].high;
		}

		const current = data[i];
		const range = current.high - current.low;
		if (range <= 0) continue;

		// Bullish Sweep Reclaim: price dipped below lowestLow but closed above it
		if (current.low < lowestLow && current.close > lowestLow) {
			bullish[i] = (current.close - lowestLow) / range;
		}

		// Bearish Sweep Reclaim: price spiked above highestHigh but closed below it
		if (current.high > highestHigh && current.close < highestHigh) {
			bearish[i] = (highestHigh - current.close) / range;
		}
	}
	return { bullish, bearish };
}


