import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';

interface Config {
    trendEmaPeriod: number;
    momentum3Lookback: number;
    momentum6Lookback: number;
    momentum12Lookback: number;
    minMomentum3Pct: number;
    minMomentum6Pct: number;
    minMomentum12Pct: number;
    atrPeriod: number;
    volLookback: number;
    maxVolRankPct: number;
    rebalanceBars: number;
    confirmBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function percentileRank(values: (number | null)[], lookback: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current === null || i < lookback - 1) continue;

        const start = i - lookback + 1;
        let belowOrEqual = 0;
        let valid = 0;
        for (let j = start; j <= i; j++) {
            const candidate = values[j];
            if (candidate === null) continue;
            valid++;
            if (candidate <= current) belowOrEqual++;
        }
        if (valid > 0) out[i] = belowOrEqual / valid;
    }

    return out;
}

function normalizeConfig(params: StrategyParams): Config {
    const momentum3Lookback = Math.max(5, Math.min(500, Math.round(params.momentum3Lookback ?? 63)));
    const momentum6Lookback = Math.max(momentum3Lookback + 1, Math.min(800, Math.round(params.momentum6Lookback ?? 126)));
    const momentum12Lookback = Math.max(momentum6Lookback + 1, Math.min(1200, Math.round(params.momentum12Lookback ?? 252)));
    return {
        trendEmaPeriod: Math.max(20, Math.min(800, Math.round(params.trendEmaPeriod ?? 200))),
        momentum3Lookback,
        momentum6Lookback,
        momentum12Lookback,
        minMomentum3Pct: clamp(params.minMomentum3Pct ?? 10, -80, 600),
        minMomentum6Pct: clamp(params.minMomentum6Pct ?? 20, -80, 800),
        minMomentum12Pct: clamp(params.minMomentum12Pct ?? 30, -80, 1200),
        atrPeriod: Math.max(2, Math.min(100, Math.round(params.atrPeriod ?? 14))),
        volLookback: Math.max(20, Math.min(1200, Math.round(params.volLookback ?? 252))),
        maxVolRankPct: clamp(params.maxVolRankPct ?? 70, 1, 99),
        rebalanceBars: Math.max(1, Math.min(120, Math.round(params.rebalanceBars ?? 5))),
        confirmBars: Math.max(1, Math.min(20, Math.round(params.confirmBars ?? 2))),
    };
}

export const momentum_rsi_regime_gate: Strategy = {
    name: 'Momentum RSI Regime Gate',
    description: 'Filter state for momentum RSI systems: risk-on only when trend, multi-horizon momentum, and volatility percentile conditions align.',
    defaultParams: {
        trendEmaPeriod: 200,
        momentum3Lookback: 63,
        momentum6Lookback: 126,
        momentum12Lookback: 252,
        minMomentum3Pct: 10,
        minMomentum6Pct: 20,
        minMomentum12Pct: 30,
        atrPeriod: 14,
        volLookback: 252,
        maxVolRankPct: 70,
        rebalanceBars: 5,
        confirmBars: 2,
    },
    paramLabels: {
        trendEmaPeriod: 'Trend EMA Period',
        momentum3Lookback: 'Momentum 3M Lookback (bars)',
        momentum6Lookback: 'Momentum 6M Lookback (bars)',
        momentum12Lookback: 'Momentum 12M Lookback (bars)',
        minMomentum3Pct: 'Min Momentum 3M (%)',
        minMomentum6Pct: 'Min Momentum 6M (%)',
        minMomentum12Pct: 'Min Momentum 12M (%)',
        atrPeriod: 'ATR Period',
        volLookback: 'Volatility Rank Lookback',
        maxVolRankPct: 'Max Volatility Rank (%)',
        rebalanceBars: 'Rebalance Every N Bars',
        confirmBars: 'Regime Confirm Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeConfig(params);
        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const trend = calculateEMA(closes, cfg.trendEmaPeriod);
        const atr = calculateATR(highs, lows, closes, cfg.atrPeriod);
        const atrPct: (number | null)[] = new Array(closes.length).fill(null);

        for (let i = 0; i < closes.length; i++) {
            const atrNow = atr[i];
            if (atrNow === null || closes[i] <= 0) continue;
            atrPct[i] = (atrNow / closes[i]) * 100;
        }

        const volRank = percentileRank(atrPct, cfg.volLookback);
        const maxVolRank = cfg.maxVolRankPct / 100;
        const minBars = Math.max(
            cfg.trendEmaPeriod,
            cfg.momentum3Lookback,
            cfg.momentum6Lookback,
            cfg.momentum12Lookback,
            cfg.volLookback
        );

        const signals: Signal[] = [];
        let riskOn = false;
        let onStreak = 0;
        let offStreak = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;
            if (i % cfg.rebalanceBars !== 0) continue;

            const trendNow = trend[i];
            const volRankNow = volRank[i];
            if (trendNow === null || volRankNow === null) continue;

            const momentum3 = ((closes[i] / closes[i - cfg.momentum3Lookback]) - 1) * 100;
            const momentum6 = ((closes[i] / closes[i - cfg.momentum6Lookback]) - 1) * 100;
            const momentum12 = ((closes[i] / closes[i - cfg.momentum12Lookback]) - 1) * 100;
            const trendPass = closes[i] >= trendNow;
            const momentumPass =
                momentum3 >= cfg.minMomentum3Pct &&
                momentum6 >= cfg.minMomentum6Pct &&
                momentum12 >= cfg.minMomentum12Pct;
            const volPass = volRankNow <= maxVolRank;
            const regimePass = trendPass && momentumPass && volPass;

            if (!riskOn) {
                if (regimePass) {
                    onStreak++;
                } else {
                    onStreak = 0;
                }

                if (onStreak >= cfg.confirmBars) {
                    signals.push(createBuySignal(cleanData, i, 'Momentum RSI regime risk-on'));
                    riskOn = true;
                    onStreak = 0;
                    offStreak = 0;
                }
                continue;
            }

            if (!regimePass) {
                offStreak++;
            } else {
                offStreak = 0;
            }

            if (offStreak >= cfg.confirmBars) {
                signals.push(createSellSignal(cleanData, i, 'Momentum RSI regime risk-off'));
                riskOn = false;
                onStreak = 0;
                offStreak = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: 'filter',
        direction: 'long',
        walkForwardParams: [
            'trendEmaPeriod',
            'momentum3Lookback',
            'momentum6Lookback',
            'momentum12Lookback',
            'minMomentum3Pct',
            'minMomentum6Pct',
            'minMomentum12Pct',
            'atrPeriod',
            'volLookback',
            'maxVolRankPct',
            'rebalanceBars',
            'confirmBars',
        ],
    },
};

