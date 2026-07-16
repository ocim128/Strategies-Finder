import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
	checkCrossover,
} from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	vahByLookback: Map<number, (number | null)[]>;
	valByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
		volumeThreshold: Number(params.volumeThreshold ?? 0.45),
	};
}

export const value_area_deviation_reversion: Strategy = {
	name: "Value Area Deviation Reversion",
	description: "Fades price deviations outside the rolling volume profile value area (VAH/VAL) when volume is low and close crosses back inside the value area.",
	defaultParams: {
		lookback: 50,
		volumeThreshold: 0.45,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volumeThreshold: "Volume Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		vahByLookback: new Map<number, (number | null)[]>(),
		valByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volumeThreshold = p.volumeThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);

		const vahByLookback = prepared?.vahByLookback ?? new Map<number, (number | null)[]>();
		const valByLookback = prepared?.valByLookback ?? new Map<number, (number | null)[]>();

		let vah = vahByLookback.get(lookback);
		let val = valByLookback.get(lookback);

		if (!vah || !val) {
			const va = buildRollingValueArea(cleanData, lookback);
			vah = va.vah;
			val = va.val;
			vahByLookback.set(lookback, vah);
			valByLookback.set(lookback, val);
		}

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(volumes, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		return createSignalLoop(cleanData, [vah, val, volPct], (i) => {
			if (i < lookback) return null;

			const vp = volPct![i];
			if (vp === null || vp >= volumeThreshold) return null;

			// Check close crossing back inside the value area:
			// crosses above VAL (bullish crossover)
			const crossBuy = checkCrossover(closes, val!, i);
			// crosses below VAH (bearish crossover)
			const crossSell = checkCrossover(closes, vah!, i);

			if (crossBuy === "bullish") {
				return createBuySignal(cleanData, i, `Value area buy: close crossed back above VAL, Vol Pct ${vp.toFixed(2)}`);
			}
			if (crossSell === "bearish") {
				return createSellSignal(cleanData, i, `Value area sell: close crossed back below VAH, Vol Pct ${vp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		value_area_deviation_reversion.executePrepared!(
			value_area_deviation_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volumeThreshold"],
	},
};
