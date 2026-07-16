import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingMinMax, buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	minByLookback: Map<number, (number | null)[]>;
	maxByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
		maxVolumePercentile: Number(params.maxVolumePercentile ?? 0.25),
	};
}

export const proxy_volume_divergence_reversion: Strategy = {
	name: "Proxy Volume Divergence Reversion",
	description: "Fades rolling extremes when volume percentile rank is extremely low, indicating a low-liquidity anomaly.",
	defaultParams: {
		lookback: 40,
		maxVolumePercentile: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxVolumePercentile: "Max Volume Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		minByLookback: new Map<number, (number | null)[]>(),
		maxByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const maxVolumePercentile = p.maxVolumePercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);

		const minByLookback = prepared?.minByLookback ?? new Map<number, (number | null)[]>();
		const maxByLookback = prepared?.maxByLookback ?? new Map<number, (number | null)[]>();

		let channelMin = minByLookback.get(lookback);
		let channelMax = maxByLookback.get(lookback);

		if (!channelMin || !channelMax) {
			const minMax = buildRollingMinMax(closes, lookback);
			channelMin = minMax.min;
			channelMax = minMax.max;
			minByLookback.set(lookback, channelMin);
			maxByLookback.set(lookback, channelMax);
		}

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(volumes, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		return createSignalLoop(cleanData, [channelMin, channelMax, volPct], (i) => {
			if (i < lookback) return null;

			const cMin = channelMin![i];
			const cMax = channelMax![i];
			const vp = volPct[i];
			if (cMin === null || cMax === null || vp === null) return null;

			const close = closes[i];

			// Buy: close is within 2% of the rolling minimum close, but the volume percentile rank is below maxVolumePercentile
			if (close <= cMin * 1.02 && vp < maxVolumePercentile) {
				return createBuySignal(cleanData, i, `Volume divergence buy: close ${close.toFixed(2)} within 2% of min ${cMin.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			// Sell: close is within 2% of the rolling maximum close, but the volume percentile rank is below maxVolumePercentile
			if (close >= cMax * 0.98 && vp < maxVolumePercentile) {
				return createSellSignal(cleanData, i, `Volume divergence sell: close ${close.toFixed(2)} within 2% of max ${cMax.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		proxy_volume_divergence_reversion.executePrepared!(
			proxy_volume_divergence_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxVolumePercentile"],
	},
};
