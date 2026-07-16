import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		volSurgeThreshold: Number(params.volSurgeThreshold ?? 0.92),
	};
}

export const proxy_volume_exhaustion_cap: Strategy = {
	name: "Proxy Volume Exhaustion Cap",
	description: "Fades price extremes (Z-score 2.0) when proxy volume percentile falls below 0.50 immediately after a top-tail volume surge (above volSurgeThreshold).",
	defaultParams: {
		lookback: 35,
		volSurgeThreshold: 0.92,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volSurgeThreshold: "Volume Surge Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volSurgeThreshold = p.volSurgeThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(volumes, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		return createSignalLoop(cleanData, [zscore, volPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const prevVp = volPct[i - 1];
			const vp = volPct[i];
			if (z === null || prevVp === null || vp === null) return null;

			// Buy/Sell: Z-score limits, previous bar volume percentile above surge threshold, current below 0.50
			const volDecay = prevVp > volSurgeThreshold && vp < 0.50;

			if (volDecay) {
				if (z < -2.0) {
					return createBuySignal(cleanData, i, `Volume exhaustion buy: Z ${z.toFixed(2)}, prev Vol Pct ${prevVp.toFixed(2)} -> current ${vp.toFixed(2)}`);
				}
				if (z > 2.0) {
					return createSellSignal(cleanData, i, `Volume exhaustion sell: Z ${z.toFixed(2)}, prev Vol Pct ${prevVp.toFixed(2)} -> current ${vp.toFixed(2)}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		proxy_volume_exhaustion_cap.executePrepared!(
			proxy_volume_exhaustion_cap.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volSurgeThreshold"],
	},
};
