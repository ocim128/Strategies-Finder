import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

const _returns = new WeakMap<OHLCVData[], number[]>();
function getReturns(data: OHLCVData[]): number[] {
    let r = _returns.get(data);
    if (!r) {
        const closes = getCloses(data);
        r = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            r[i] = closes[i] - closes[i - 1];
        }
        _returns.set(data, r);
    }
    return r;
}

const _volChanges = new WeakMap<OHLCVData[], number[]>();
function getVolumeChanges(data: OHLCVData[]): number[] {
    let vc = _volChanges.get(data);
    if (!vc) {
        const volumes = getVolumes(data);
        vc = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            vc[i] = volumes[i] - volumes[i - 1];
        }
        _volChanges.set(data, vc);
    }
    return vc;
}

// #COMPLETION_DRIVE: Assuming price returns and volume correlation drops under range boundary limits capture buying/selling exhaustion.
// #SUGGEST_VERIFY: Verify trailing range values are non-zero to avoid division-by-zero or out-of-bounds percentiles.
function normalizeVolumeWeightedCloseCorrelationReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        correlationLimit: Number(params.correlationLimit ?? -0.5),
    };
}

export const volume_weighted_close_correlation_reversion: Strategy = {
    name: "Volume-Weighted Close Correlation Reversion",
    description: "Reverts range boundary excursions when the rolling correlation between volume changes and returns collapses to extreme negatives.",
    defaultParams: {
        lookback: 35,
        correlationLimit: -0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        correlationLimit: "Correlation Limit",
    },
    normalizeParams: normalizeVolumeWeightedCloseCorrelationReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeWeightedCloseCorrelationReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);
        const volChanges = getVolumeChanges(cleanData);

        const corr = buildRollingCorrelation(volChanges, returns, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [corr, highest, lowest], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentCorr = corr[i];
            const hi = highest[i];
            const lo = lowest[i];

            if (currentCorr === null || hi === null || lo === null) return null;

            const range = hi - lo;
            if (range <= 0) return null;

            const distToLowPct = (currentClose - lo) / range;
            const distToHighPct = (hi - currentClose) / range;

            if (currentCorr < p.correlationLimit) {
                // Buy logic: Close is within 5% of trailing low boundary and correlation is below correlationLimit
                if (distToLowPct <= 0.05) {
                    return createBuySignal(cleanData, i, `Bullish Vol Corr Exhaustion (corr=${currentCorr.toFixed(3)}, distLow=${(distToLowPct * 100).toFixed(1)}%)`);
                }
                // Sell logic: Close is within 5% of trailing high boundary and correlation is below correlationLimit
                if (distToHighPct <= 0.05) {
                    return createSellSignal(cleanData, i, `Bearish Vol Corr Exhaustion (corr=${currentCorr.toFixed(3)}, distHigh=${(distToHighPct * 100).toFixed(1)}%)`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationLimit"],
    },
};
