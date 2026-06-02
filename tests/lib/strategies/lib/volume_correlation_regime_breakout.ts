import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingHighLow } from "./price-action-frequency-core";
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

// #COMPLETION_DRIVE: Assuming price returns and volume correlation breakouts represent coordinated algorithmic execution.
// #SUGGEST_VERIFY: Verify trailing high/low limits are not flat to prevent division by zero or invalid boundary percentiles.
function normalizeVolumeCorrelationRegimeBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        minCorr: Math.max(0.01, Math.min(0.99, Number(params.minCorr ?? 0.45))),
    };
}

export const volume_correlation_regime_breakout: Strategy = {
    name: "Volume Correlation Regime Breakout",
    description: "Signals boundary breakouts only when price-volume return correlation is strongly positive, indicating algorithmic execution.",
    defaultParams: {
        lookback: 30,
        minCorr: 0.45,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minCorr: "Min Correlation",
    },
    normalizeParams: normalizeVolumeCorrelationRegimeBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeCorrelationRegimeBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);
        const volChanges = getVolumeChanges(cleanData);

        const corr = buildRollingCorrelation(volChanges, returns, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [corr, highest, lowest, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentCorr = corr[i];
            const hi = highest[i];
            const lo = lowest[i];
            const acc = closeAcceptance[i];

            if (currentCorr === null || hi === null || lo === null || acc === null) return null;
            if (currentCorr <= p.minCorr) return null;

            // Buy logic: Close breaks above trailing high, close acceptance is positive, and the rolling correlation is above minCorr
            if (currentClose > hi && acc > 0) {
                return createBuySignal(cleanData, i, `Bullish Vol Correlation Breakout (corr=${currentCorr.toFixed(3)}, close=${currentClose.toFixed(2)}, hi=${hi.toFixed(2)})`);
            }

            // Sell logic: Close breaks below trailing low, close acceptance is negative, and the rolling correlation is above minCorr
            if (currentClose < lo && acc < 0) {
                return createSellSignal(cleanData, i, `Bearish Vol Correlation Breakout (corr=${currentCorr.toFixed(3)}, close=${currentClose.toFixed(2)}, lo=${lo.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCorr"],
    },
};
