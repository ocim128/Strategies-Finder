import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		minKellyFraction: Number(params.minKellyFraction ?? 0.25),
	};
}

export const kelly_proxy_volume_gated_reversion: Strategy = {
	name: "Kelly Proxy Volume Gated Reversion",
	description: "Fades price deviations when low relative volume WinRate (1 - volumePercentile) maps to positive Kelly allocation above minKellyFraction.",
	defaultParams: {
		lookback: 30,
		minKellyFraction: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
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
		const minKellyFraction = p.minKellyFraction as number;

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
			const vp = volPct[i];
			if (z === null || vp === null) return null;

			const winProb = 1 - vp;
			const kelly = 2 * winProb - 1;

			if (kelly > minKellyFraction) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Volume gated Kelly buy: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Volume gated Kelly sell: Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_proxy_volume_gated_reversion.executePrepared!(
			kelly_proxy_volume_gated_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
