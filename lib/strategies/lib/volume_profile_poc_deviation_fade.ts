import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

type PocDeviationPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	pocByLookback: Map<number, (number | null)[]>;
	stdDevByLookback: Map<number, (number | null)[]>;
};

function normalizePocDeviationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
	};
}

function preparePocDeviationData(data: OHLCVData[]): PocDeviationPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		pocByLookback: new Map(),
		stdDevByLookback: new Map(),
	};
}

function getPreparedPocDeviationData(preparedData: unknown, data: OHLCVData[]): PocDeviationPrepared {
	if (preparedData && typeof preparedData === "object" && "pocByLookback" in preparedData) {
		return preparedData as PocDeviationPrepared;
	}
	return preparePocDeviationData(data);
}

export const volume_profile_poc_deviation_fade: Strategy = {
	name: "Volume Profile POC Deviation Fade",
	description: "Fades the typical price when it deviates significantly from the volume profile Point of Control (POC).",
	defaultParams: {
		lookback: 40,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizePocDeviationParams,
	prepareFinderData: (data) => preparePocDeviationData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedPocDeviationData(preparedData, data);
		const p = normalizePocDeviationParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let poc = prepared.pocByLookback.get(lookback);
		if (!poc) {
			const va = buildRollingValueArea(prepared.data, lookback);
			poc = va.poc;
			prepared.pocByLookback.set(lookback, poc);
		}

		let stddev = prepared.stdDevByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(prepared.typicalPrices, lookback);
			prepared.stdDevByLookback.set(lookback, stddev);
		}

		return createSignalLoop(prepared.data, [poc, stddev], (i) => {
			if (i < lookback) return null;
			const currentPoc = poc[i];
			const currentStd = stddev[i];
			if (currentPoc === null || currentStd === null || currentStd <= 1e-9) return null;

			const tp = prepared.typicalPrices[i];
			const deviation = tp - currentPoc;
			const z = deviation / currentStd;

			if (z <= -2.0) {
				return createBuySignal(prepared.data, i, `Typical price crossed below POC: Z-Score (${z.toFixed(2)}) <= -2.0`);
			}
			if (z >= 2.0) {
				return createSellSignal(prepared.data, i, `Typical price crossed above POC: Z-Score (${z.toFixed(2)}) >= 2.0`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volume_profile_poc_deviation_fade.executePrepared?.(preparePocDeviationData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
