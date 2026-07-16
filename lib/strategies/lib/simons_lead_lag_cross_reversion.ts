import {
	Strategy,
	OHLCVData,
	StrategyParams,
	StrategyExecutionContext,
} from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	cleanData: OHLCVData[];
	secondarySymbol: string | null;
	primaryCloses: number[];
	primaryReturns: number[];
	secondaryReturns: number[] | null;
	zScoreByLookback: Map<number, (number | null)[]>;
	corrByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		correlationLimit: Number(params.correlationLimit ?? 0.15),
	};
}

function prepareData(data: OHLCVData[], context?: StrategyExecutionContext): PreparedData {
	const cleanData = ensureCleanData(data);
	const primaryCloses = getCloses(cleanData);
	const primaryReturns = extractBarMetricSeries(cleanData, "closeReturn");

	if (!context?.crossSymbol) {
		return {
			cleanData,
			secondarySymbol: null,
			primaryCloses,
			primaryReturns,
			secondaryReturns: null,
			zScoreByLookback: new Map<number, (number | null)[]>(),
			corrByLookback: new Map<number, (number | null)[]>(),
		};
	}

	const secondaryData = ensureCleanData(context.crossSymbol.secondaryData);
	const secondaryReturns = extractBarMetricSeries(secondaryData, "closeReturn");

	return {
		cleanData,
		secondarySymbol: context.crossSymbol.secondarySymbol,
		primaryCloses,
		primaryReturns,
		secondaryReturns,
		zScoreByLookback: new Map<number, (number | null)[]>(),
		corrByLookback: new Map<number, (number | null)[]>(),
	};
}

function getPreparedData(
	preparedData: unknown,
	data: OHLCVData[],
	context?: StrategyExecutionContext
): PreparedData {
	if (preparedData && typeof preparedData === "object" && "corrByLookback" in preparedData) {
		const prepared = preparedData as PreparedData;
		const currentSymbol = context?.crossSymbol?.secondarySymbol ?? null;
		if (prepared.secondarySymbol === currentSymbol) {
			return prepared;
		}
	}
	return prepareData(data, context);
}

export const simons_lead_lag_cross_reversion: Strategy = {
	name: "Simons Lead Lag Cross Reversion",
	description: "Fades price deviations when base and quote close returns decoupling correlation falls below correlationLimit.",
	defaultParams: {
		lookback: 30,
		correlationLimit: 0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		correlationLimit: "Correlation Limit",
	},
	normalizeParams,
	crossSymbolConfig: {
		defaultSymbol: "BTCUSDT",
		userSelectable: true,
		minBars: 50,
	},
	prepareFinderData: (data, _settings, context) => prepareData(data, context),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
		if (!context?.crossSymbol) return [];

		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const correlationLimit = p.correlationLimit as number;

		const prepared = getPreparedData(preparedData, data, context);
		const cleanData = prepared.cleanData;
		if (cleanData.length < lookback + 2) return [];

		const primaryCloses = prepared.primaryCloses;
		const primaryReturns = prepared.primaryReturns;
		const secondaryReturns = prepared.secondaryReturns;
		if (!secondaryReturns) return [];

		const zScoreByLookback = prepared.zScoreByLookback;
		let zscore = zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(primaryCloses, lookback);
			zScoreByLookback.set(lookback, zscore);
		}

		const corrByLookback = prepared.corrByLookback;
		let corr = corrByLookback.get(lookback);
		if (!corr) {
			corr = buildRollingCorrelation(primaryReturns, secondaryReturns, lookback);
			corrByLookback.set(lookback, corr);
		}

		return createSignalLoop(cleanData, [zscore, corr], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			const c = corr[i];
			if (z === null || c === null) return null;

			// Buy: Z-score < -1.8, and rolling correlation between base and quote close returns < correlationLimit
			if (z < -1.8 && c < correlationLimit) {
				return createBuySignal(cleanData, i, `Base-quote return decoupling: correlation ${c.toFixed(2)}, ratio Z ${z.toFixed(2)}`);
			}
			// Sell: Z-score > 1.8, and rolling correlation between base and quote close returns < correlationLimit
			if (z > 1.8 && c < correlationLimit) {
				return createSellSignal(cleanData, i, `Base-quote return decoupling: correlation ${c.toFixed(2)}, ratio Z ${z.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params, context) =>
		simons_lead_lag_cross_reversion.executePrepared!(
			simons_lead_lag_cross_reversion.prepareFinderData!(data, undefined, context),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "correlationLimit"],
	},
};
