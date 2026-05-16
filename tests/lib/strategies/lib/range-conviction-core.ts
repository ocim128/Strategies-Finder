import { OHLCVData } from "../../types/strategies";
import { calculateADX, calculateATR, calculateCMF, calculateVolumeProfile } from "../indicators";
import { ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import {
	buildCloseAcceptanceSeries,
	buildCloseLocationSeries,
	buildRollingAverage,
	buildTrailingHighLow,
	buildTrailingWindowSpan,
	extractBarMetricSeries,
} from "./price-action-frequency-core";
import {
	buildEfficiencyRatio,
	buildPercentileRank,
	buildRateOfChange,
	buildRollingEntropy,
	buildRollingMedian,
	buildRollingMinMax,
	buildRollingZScore,
} from "./price-action-statistics-core";

export const STRONG_ACCEPTANCE = 0.55;
export const FIXED_ADX_PERIOD = 14;
export const VALUE_PROFILE_BINS = 24;

export type NullableSeries = (number | null)[];

export type RangeConvictionPreparedData = {
	cleanData: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	volumes: number[];
	trueRange: number[];
	closeReturn: number[];
	gapPct: number[];
	bodyPct: number[];
	bodyDirection: number[];
	closeLocation: number[];
	acceptance: number[];
	atrByPeriod: Map<number, NullableSeries>;
	adxByPeriod: Map<number, NullableSeries>;
	cmfByLookback: Map<number, NullableSeries>;
	rangeRankByLookback: Map<number, NullableSeries>;
	volumeRankByLookback: Map<number, NullableSeries>;
	averageRangeRankByLookback: Map<number, NullableSeries>;
	efficiencyByLookback: Map<number, NullableSeries>;
	entropyByLookback: Map<number, NullableSeries>;
	gapZByLookback: Map<number, NullableSeries>;
	medianCloseByLookback: Map<number, NullableSeries>;
	volumeAverageByLookback: Map<number, NullableSeries>;
	rocByPeriod: Map<number, NullableSeries>;
	trailingByLookback: Map<number, {
		highest: NullableSeries;
		lowest: NullableSeries;
		span: NullableSeries;
	}>;
	priorCloseBoundaryByLookback: Map<number, {
		highestClose: NullableSeries;
		lowestClose: NullableSeries;
	}>;
	profileByLookback: Map<number, {
		poc: NullableSeries;
		vah: NullableSeries;
		val: NullableSeries;
	}>;
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
		volumes: getVolumes(cleanData),
		trueRange: extractBarMetricSeries(cleanData, "trueRange"),
		closeReturn: extractBarMetricSeries(cleanData, "closeReturn"),
		gapPct: extractBarMetricSeries(cleanData, "gapPct"),
		bodyPct: extractBarMetricSeries(cleanData, "bodyPct"),
		bodyDirection: extractBarMetricSeries(cleanData, "bodyDirection"),
		closeLocation: buildCloseLocationSeries(cleanData),
		acceptance: buildCloseAcceptanceSeries(cleanData),
		atrByPeriod: new Map(),
		adxByPeriod: new Map(),
		cmfByLookback: new Map(),
		rangeRankByLookback: new Map(),
		volumeRankByLookback: new Map(),
		averageRangeRankByLookback: new Map(),
		efficiencyByLookback: new Map(),
		entropyByLookback: new Map(),
		gapZByLookback: new Map(),
		medianCloseByLookback: new Map(),
		volumeAverageByLookback: new Map(),
		rocByPeriod: new Map(),
		trailingByLookback: new Map(),
		priorCloseBoundaryByLookback: new Map(),
		profileByLookback: new Map(),
	};
}

export function getPreparedRangeConvictionData(
	preparedData: unknown,
	data: OHLCVData[]
): RangeConvictionPreparedData {
	if (preparedData && typeof preparedData === "object" && "rangeRankByLookback" in preparedData) {
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

export function getAdxSeries(prepared: RangeConvictionPreparedData, period = FIXED_ADX_PERIOD): NullableSeries {
	let adx = prepared.adxByPeriod.get(period);
	if (!adx) {
		adx = calculateADX(prepared.highs, prepared.lows, prepared.closes, period);
		prepared.adxByPeriod.set(period, adx);
	}
	return adx;
}

export function getCmfSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let cmf = prepared.cmfByLookback.get(lookback);
	if (!cmf) {
		cmf = calculateCMF(prepared.highs, prepared.lows, prepared.closes, prepared.volumes, lookback);
		prepared.cmfByLookback.set(lookback, cmf);
	}
	return cmf;
}

export function getRangeRankSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let rank = prepared.rangeRankByLookback.get(lookback);
	if (!rank) {
		rank = buildPercentileRank(prepared.trueRange, lookback);
		prepared.rangeRankByLookback.set(lookback, rank);
	}
	return rank;
}

export function getVolumeRankSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let rank = prepared.volumeRankByLookback.get(lookback);
	if (!rank) {
		rank = buildPercentileRank(prepared.volumes, lookback);
		prepared.volumeRankByLookback.set(lookback, rank);
	}
	return rank;
}

export function getAverageRangeRankSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let rank = prepared.averageRangeRankByLookback.get(lookback);
	if (!rank) {
		const averageRange = buildRollingAverage(prepared.trueRange, lookback);
		const finiteAverageRange = averageRange.map((value) => value ?? Number.NaN);
		rank = buildPercentileRank(finiteAverageRange, lookback);
		prepared.averageRangeRankByLookback.set(lookback, rank);
	}
	return rank;
}

export function getEfficiencySeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let efficiency = prepared.efficiencyByLookback.get(lookback);
	if (!efficiency) {
		efficiency = buildEfficiencyRatio(prepared.cleanData, lookback);
		prepared.efficiencyByLookback.set(lookback, efficiency);
	}
	return efficiency;
}

export function getEntropySeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let entropy = prepared.entropyByLookback.get(lookback);
	if (!entropy) {
		entropy = buildRollingEntropy(prepared.closeReturn, lookback);
		prepared.entropyByLookback.set(lookback, entropy);
	}
	return entropy;
}

export function getGapZSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let gapZ = prepared.gapZByLookback.get(lookback);
	if (!gapZ) {
		gapZ = buildRollingZScore(prepared.gapPct, lookback);
		prepared.gapZByLookback.set(lookback, gapZ);
	}
	return gapZ;
}

export function getMedianCloseSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let median = prepared.medianCloseByLookback.get(lookback);
	if (!median) {
		median = buildRollingMedian(prepared.closes, lookback);
		prepared.medianCloseByLookback.set(lookback, median);
	}
	return median;
}

export function getVolumeAverageSeries(prepared: RangeConvictionPreparedData, lookback: number): NullableSeries {
	let average = prepared.volumeAverageByLookback.get(lookback);
	if (!average) {
		average = buildRollingAverage(prepared.volumes, lookback);
		prepared.volumeAverageByLookback.set(lookback, average);
	}
	return average;
}

export function getRocSeries(prepared: RangeConvictionPreparedData, period: number): NullableSeries {
	let roc = prepared.rocByPeriod.get(period);
	if (!roc) {
		roc = buildRateOfChange(prepared.closes, period);
		prepared.rocByPeriod.set(period, roc);
	}
	return roc;
}

export function getTrailingRangeSeries(
	prepared: RangeConvictionPreparedData,
	lookback: number
): { highest: NullableSeries; lowest: NullableSeries; span: NullableSeries } {
	let trailing = prepared.trailingByLookback.get(lookback);
	if (!trailing) {
		const { highest, lowest } = buildTrailingHighLow(prepared.cleanData, lookback, false);
		trailing = {
			highest,
			lowest,
			span: buildTrailingWindowSpan(prepared.cleanData, lookback, false),
		};
		prepared.trailingByLookback.set(lookback, trailing);
	}
	return trailing;
}

export function getPriorCloseBoundarySeries(
	prepared: RangeConvictionPreparedData,
	lookback: number
): { highestClose: NullableSeries; lowestClose: NullableSeries } {
	let boundary = prepared.priorCloseBoundaryByLookback.get(lookback);
	if (!boundary) {
		const rolling = buildRollingMinMax(prepared.closes, lookback);
		const highestClose: NullableSeries = new Array(prepared.closes.length).fill(null);
		const lowestClose: NullableSeries = new Array(prepared.closes.length).fill(null);
		for (let i = 1; i < prepared.closes.length; i++) {
			highestClose[i] = rolling.max[i - 1];
			lowestClose[i] = rolling.min[i - 1];
		}
		boundary = { highestClose, lowestClose };
		prepared.priorCloseBoundaryByLookback.set(lookback, boundary);
	}
	return boundary;
}

export function getVolumeProfileSeries(
	prepared: RangeConvictionPreparedData,
	lookback: number
): { poc: NullableSeries; vah: NullableSeries; val: NullableSeries } {
	let profile = prepared.profileByLookback.get(lookback);
	if (!profile) {
		profile = calculateVolumeProfile(prepared.cleanData, lookback, VALUE_PROFILE_BINS);
		prepared.profileByLookback.set(lookback, profile);
	}
	return profile;
}





