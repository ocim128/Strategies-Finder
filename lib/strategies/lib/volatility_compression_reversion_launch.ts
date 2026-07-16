import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	tr: number[];
	closeLocation: number[];
	volPctByLookback: Map<number, (number | null)[]>;
	ratioPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		volPercentileLimit: Number(params.volPercentileLimit ?? 0.3),
	};
}

export const volatility_compression_reversion_launch: Strategy = {
	name: "Volatility Compression Reversion Launch",
	description: "Fades compressed low-volatility drift to extreme rolling percentiles when a sudden range expansion is rejected.",
	defaultParams: {
		lookback: 30,
		volPercentileLimit: 0.3,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volPercentileLimit: "Vol Percentile Limit",
	},
	normalizeParams,
	prepareFinderData: (data) => {
		const cleanData = ensureCleanData(data);
		return {
			data: cleanData,
			closes: getCloses(cleanData),
			returns: extractBarMetricSeries(cleanData, "closeReturn"),
			tr: extractBarMetricSeries(cleanData, "trueRange"),
			closeLocation: buildCloseLocationSeries(cleanData),
			volPctByLookback: new Map<number, (number | null)[]>(),
			ratioPctByLookback: new Map<number, (number | null)[]>(),
		};
	},
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volPercentileLimit = p.volPercentileLimit as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");
		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			const stddev = buildRollingStdDev(returns, lookback);
			const cleanStd = stddev.map((v) => v ?? 0);
			volPct = buildPercentileRank(cleanStd, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		const ratioPctByLookback = prepared?.ratioPctByLookback ?? new Map<number, (number | null)[]>();
		let ratioPct = ratioPctByLookback.get(lookback);
		if (!ratioPct) {
			ratioPct = buildPercentileRank(closes, lookback);
			ratioPctByLookback.set(lookback, ratioPct);
		}

		return createSignalLoop(cleanData, [volPct, ratioPct], (i) => {
			if (i < lookback) return null;

			const prevVp = volPct![i - 1];
			const rp = ratioPct![i];
			if (prevVp === null || rp === null) return null;

			const currentTr = tr[i];
			const prevTr = tr[i - 1];
			const cl = closeLocation[i];

			const rangeExpanding = currentTr > prevTr;

			if (prevVp < volPercentileLimit && rangeExpanding) {
				// Buy: ratio is at low rolling percentile (rp < 0.2) and close location > 0.8 (reversion launch)
				if (rp < 0.2 && cl > 0.8) {
					return createBuySignal(cleanData, i, `Vol compression launch buy: prevVolPct ${prevVp.toFixed(2)}, ratioPct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
				}
				// Sell: ratio is at high rolling percentile (rp > 0.8) and close location < 0.2 (reversion launch)
				if (rp > 0.8 && cl < 0.2) {
					return createSellSignal(cleanData, i, `Vol compression launch sell: prevVolPct ${prevVp.toFixed(2)}, ratioPct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		volatility_compression_reversion_launch.executePrepared!(
			volatility_compression_reversion_launch.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volPercentileLimit"],
	},
};
