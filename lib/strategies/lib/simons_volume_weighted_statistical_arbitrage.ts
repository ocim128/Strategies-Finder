import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getHighs,
	getLows,
	getVolumes,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	highs: number[];
	lows: number[];
	volumes: number[];
	vwapByLookback: Map<number, (number | null)[]>;
	zscoreByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		volCutoff: Math.max(0, Math.min(1, Number(params.volCutoff ?? 0.35))),
	};
}

export const simons_volume_weighted_statistical_arbitrage: Strategy = {
	name: "Simons Volume Weighted Statistical Arbitrage",
	description: "Fades ratio price deviations from rolling VWAP on declining proxy volume.",
	defaultParams: {
		lookback: 30,
		volCutoff: 0.35,
	},
	paramLabels: {
		lookback: "Lookback Window",
		volCutoff: "Volume Cutoff",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		highs: getHighs(data),
		lows: getLows(data),
		volumes: getVolumes(data),
		vwapByLookback: new Map<number, (number | null)[]>(),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const volCutoff = p.volCutoff as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const highs = prepared?.highs ?? getHighs(cleanData);
		const lows = prepared?.lows ?? getLows(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);

		const vwapByLookback = prepared?.vwapByLookback ?? new Map<number, (number | null)[]>();
		let vwap = vwapByLookback.get(lookback);
		if (!vwap) {
			vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
			vwapByLookback.set(lookback, vwap);
		}

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

		return createSignalLoop(cleanData, [vwap, zscore, volPct], (i) => {
			if (i < lookback) return null;

			const v = vwap[i];
			const z = zscore[i];
			const vp = volPct[i];
			if (v === null || z === null || vp === null) return null;

			const close = closes[i];

			// Buy: close below VWAP, Z-score below -1.8, volume percentile below volCutoff
			if (close < v && z < -1.8 && vp < volCutoff) {
				return createBuySignal(cleanData, i, `VWAP deviation buy: close ${close.toFixed(2)} < VWAP ${v.toFixed(2)}, Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			// Sell: close above VWAP, Z-score above 1.8, volume percentile below volCutoff
			if (close > v && z > 1.8 && vp < volCutoff) {
				return createSellSignal(cleanData, i, `VWAP deviation sell: close ${close.toFixed(2)} > VWAP ${v.toFixed(2)}, Z ${z.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		simons_volume_weighted_statistical_arbitrage.executePrepared!(
			simons_volume_weighted_statistical_arbitrage.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "volCutoff"],
	},
};
