import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSpanPositionSkewReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailingWindow: Math.max(2, Math.round(params.trailingWindow ?? 20)),
		skewnessWindow: Math.max(3, Math.round(params.skewnessWindow ?? 30)) };
}

export const span_position_skew_reversion: Strategy = {
	name: "Span Position Skew Reversion",
	description: "Rolling skewness of price position within its trailing range reveals persistent asymmetry. Extreme skewness means price lingers near one boundary, and reversion toward the range center is favored.",
	defaultParams: {
		trailingWindow: 20,
		skewnessWindow: 30 },
	paramLabels: {
		trailingWindow: "Trailing Window",
		skewnessWindow: "Skewness Window" },
	normalizeParams: normalizeSpanPositionSkewReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSpanPositionSkewReversionParams(params);
		if (cleanData.length < p.trailingWindow + p.skewnessWindow) return [];

		const closes = getCloses(cleanData);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.trailingWindow);

		const spanPosition: number[] = new Array(cleanData.length).fill(0.5);
		for (let i = 0; i < cleanData.length; i++) {
			const hi = highest[i];
			const lo = lowest[i];
			if (hi !== null && lo !== null) {
				const spread = hi - lo;
				spanPosition[i] = spread > 0 ? (closes[i] - lo) / spread : 0.5;
			}
		}
		const skewness = buildRollingSkewness(spanPosition, p.skewnessWindow);

		return createSignalLoop(cleanData, [skewness], (i) => {
			if (i < p.trailingWindow + p.skewnessWindow) return null;
			const skew = skewness[i];
			if (skew === null) return null;

			if (skew < -1.0) {
				return createBuySignal(cleanData, i, `Span position skew ${skew.toFixed(3)} < -1.0, price persistently near range low`);
			}
			if (skew > 1.0) {
				return createSellSignal(cleanData, i, `Span position skew ${skew.toFixed(3)} > 1.0, price persistently near range high`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailingWindow", "skewnessWindow"] } };
