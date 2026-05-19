import { OHLCVData } from "../../types/strategies";
import { calculateATR } from "../indicators";
import { ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import {
	buildCloseAcceptanceSeries,
	extractBarMetricSeries,
} from "./price-action-frequency-core";

export type NullableSeries = (number | null)[];

export type RangeConvictionPreparedData = {
	cleanData: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	trueRange: number[];
	acceptance: number[];
	atrByPeriod: Map<number, NullableSeries>;
};

export function normalizeIntegerParam(
	value: number | undefined,
	fallback: number,
	min: number,
	max = Number.POSITIVE_INFINITY
): number {
	const raw = Number(value ?? fallback);
	const finite = Number.isFinite(raw) ? raw : fallback;
	return Math.max(min, Math.min(max, Math.round(finite)));
}

export function normalizeNumberParam(
	value: number | undefined,
	fallback: number,
	min: number,
	max = Number.POSITIVE_INFINITY
): number {
	const raw = Number(value ?? fallback);
	const finite = Number.isFinite(raw) ? raw : fallback;
	return Math.max(min, Math.min(max, finite));
}

export function prepareRangeConvictionData(data: OHLCVData[]): RangeConvictionPreparedData {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		highs: getHighs(cleanData),
		lows: getLows(cleanData),
		closes: getCloses(cleanData),
		trueRange: extractBarMetricSeries(cleanData, "trueRange"),
		acceptance: buildCloseAcceptanceSeries(cleanData),
		atrByPeriod: new Map(),
	};
}

export function getPreparedRangeConvictionData(
	preparedData: unknown,
	data: OHLCVData[]
): RangeConvictionPreparedData {
	if (
		preparedData
		&& typeof preparedData === "object"
		&& "atrByPeriod" in preparedData
		&& "trueRange" in preparedData
	) {
		return preparedData as RangeConvictionPreparedData;
	}
	return prepareRangeConvictionData(data);
}

export function getAtrSeries(prepared: RangeConvictionPreparedData, period: number): NullableSeries {
	let atr = prepared.atrByPeriod.get(period);
	if (!atr) {
		atr = calculateATR(prepared.highs, prepared.lows, prepared.closes, period);
		prepared.atrByPeriod.set(period, atr);
	}
	return atr;
}
