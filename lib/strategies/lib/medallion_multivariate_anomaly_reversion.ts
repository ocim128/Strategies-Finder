import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore, buildRollingStdDev } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	returns: number[];
	zPriceByLookback: Map<number, (number | null)[]>;
	zVolumeByLookback: Map<number, (number | null)[]>;
	stddevReturnsByLookback: Map<number, (number | null)[]>;
	zVolByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		anomalyThreshold: Math.max(0.1, Number(params.anomalyThreshold ?? 2.3)),
	};
}

export const medallion_multivariate_anomaly_reversion: Strategy = {
	name: "Medallion Multivariate Anomaly Reversion",
	description: "Combines price, volume, and volatility z-scores into a joint index to fade coordinated anomalies.",
	defaultParams: {
		lookback: 35,
		anomalyThreshold: 2.3,
	},
	paramLabels: {
		lookback: "Lookback Window",
		anomalyThreshold: "Anomaly Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zPriceByLookback: new Map<number, (number | null)[]>(),
		zVolumeByLookback: new Map<number, (number | null)[]>(),
		stddevReturnsByLookback: new Map<number, (number | null)[]>(),
		zVolByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const anomalyThreshold = p.anomalyThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zPriceByLookback = prepared?.zPriceByLookback ?? new Map<number, (number | null)[]>();
		let zPrice = zPriceByLookback.get(lookback);
		if (!zPrice) {
			zPrice = buildRollingZScore(closes, lookback);
			zPriceByLookback.set(lookback, zPrice);
		}

		const zVolumeByLookback = prepared?.zVolumeByLookback ?? new Map<number, (number | null)[]>();
		let zVolume = zVolumeByLookback.get(lookback);
		if (!zVolume) {
			zVolume = buildRollingZScore(volumes, lookback);
			zVolumeByLookback.set(lookback, zVolume);
		}

		const stddevReturnsByLookback = prepared?.stddevReturnsByLookback ?? new Map<number, (number | null)[]>();
		let stddev = stddevReturnsByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(returns, lookback);
			stddevReturnsByLookback.set(lookback, stddev);
		}

		// Calculate Z-score of volatility. Map stddev nulls to 0 to prevent compilation errors
		const cleanStddev = stddev.map((v) => v ?? 0);
		const zVolByLookback = prepared?.zVolByLookback ?? new Map<number, (number | null)[]>();
		let zVol = zVolByLookback.get(lookback);
		if (!zVol) {
			zVol = buildRollingZScore(cleanStddev, lookback);
			zVolByLookback.set(lookback, zVol);
		}

		return createSignalLoop(cleanData, [zPrice, zVolume, zVol], (i) => {
			if (i < lookback + 1) return null;

			const zp = zPrice[i];
			const zv = zVolume[i];
			const zt = zVol[i];
			if (zp === null || zv === null || zt === null) return null;

			const jointAnomaly = Math.sqrt(zp * zp + zv * zv + zt * zt);

			// Buy: price Z-score < -1.5, and joint anomaly index exceeds anomalyThreshold
			if (zp < -1.5 && jointAnomaly > anomalyThreshold) {
				return createBuySignal(cleanData, i, `Coordinated multivariate anomaly: index ${jointAnomaly.toFixed(2)}, price Z ${zp.toFixed(2)}`);
			}
			// Sell: price Z-score > 1.5, and joint anomaly index exceeds anomalyThreshold
			if (zp > 1.5 && jointAnomaly > anomalyThreshold) {
				return createSellSignal(cleanData, i, `Coordinated multivariate anomaly: index ${jointAnomaly.toFixed(2)}, price Z ${zp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		medallion_multivariate_anomaly_reversion.executePrepared!(
			medallion_multivariate_anomaly_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "anomalyThreshold"],
	},
};
