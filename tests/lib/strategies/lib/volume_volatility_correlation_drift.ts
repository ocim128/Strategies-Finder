import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
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

// #COMPLETION_DRIVE: Assuming volume volatility correlation shifts under low-volatility regimes act as causal accumulation indicators.
// #SUGGEST_VERIFY: Verify rolling correlation returns valid metrics and does not fail on flat returns.
function normalizeVolumeVolatilityCorrelationDriftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        minCorr: Math.max(0.01, Math.min(0.99, Number(params.minCorr ?? 0.4))),
    };
}

export const volume_volatility_correlation_drift: Strategy = {
    name: "Volume Volatility Correlation Drift",
    description: "Detects price-volume correlation alignment under low-volatility compression, highlighting stealth institutional accumulation.",
    defaultParams: {
        lookback: 35,
        minCorr: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minCorr: "Min Correlation",
    },
    normalizeParams: normalizeVolumeVolatilityCorrelationDriftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeVolatilityCorrelationDriftParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const returns = getReturns(cleanData);
        const volChanges = getVolumeChanges(cleanData);

        const corr = buildRollingCorrelation(volChanges, returns, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);

        return createSignalLoop(cleanData, [corr, atr, avgAtr], (i) => {
            if (i < lookback) return null;
            const currentCorr = corr[i];
            const currentAtr = atr[i];
            const currentAvgAtr = avgAtr[i];

            if (currentCorr === null || currentAtr === null || currentAvgAtr === null) return null;

            // Gate entry when ATR is below its rolling average (low volatility compression)
            if (currentAtr < currentAvgAtr) {
                // Buy logic: Rolling correlation of volume change and price returns is above minCorr
                if (currentCorr > p.minCorr) {
                    return createBuySignal(cleanData, i, `Stealth Correlation Accumulation (corr=${currentCorr.toFixed(3)}, ATR=${currentAtr.toFixed(4)})`);
                }
                // Sell logic: Rolling correlation of volume change and price returns is below minus minCorr
                if (currentCorr < -p.minCorr) {
                    return createSellSignal(cleanData, i, `Stealth Correlation Distribution (corr=${currentCorr.toFixed(3)}, ATR=${currentAtr.toFixed(4)})`);
                }
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
