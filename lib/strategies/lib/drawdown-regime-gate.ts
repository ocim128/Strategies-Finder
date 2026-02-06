import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateEMA } from '../indicators';

interface Config {
    ddWindow: number;
    ddDeltaWindow: number;
    trendLen: number;
    regimeSmooth: number;
    entryRiskProbPct: number;
    exitRiskProbPct: number;
    rebalanceBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

function rollingStd(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (period <= 1) return out;

    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        sum += current;
        sumSq += current * current;

        if (i >= period) {
            const leaving = values[i - period];
            sum -= leaving;
            sumSq -= leaving * leaving;
        }

        if (i >= period - 1) {
            const mean = sum / period;
            const variance = Math.max(0, sumSq / period - mean * mean);
            out[i] = Math.sqrt(variance);
        }
    }

    return out;
}

function normalize(params: StrategyParams): Config {
    const ddWindow = Math.max(30, Math.min(600, Math.round(params.ddWindow ?? 126)));
    const ddDeltaWindow = Math.max(3, Math.min(120, Math.round(params.ddDeltaWindow ?? 5)));
    const trendLen = Math.max(30, Math.min(800, Math.round(params.trendLen ?? 210)));
    const regimeSmooth = Math.max(2, Math.min(120, Math.round(params.regimeSmooth ?? 8)));
    const entryRiskProbPct = clamp(params.entryRiskProbPct ?? 35, 5, 70);
    const exitRiskRaw = clamp(params.exitRiskProbPct ?? 65, 20, 95);
    const exitRiskProbPct = Math.max(exitRiskRaw, entryRiskProbPct + 5);

    return {
        ddWindow,
        ddDeltaWindow,
        trendLen,
        regimeSmooth,
        entryRiskProbPct,
        exitRiskProbPct,
        rebalanceBars: Math.max(2, Math.min(120, Math.round(params.rebalanceBars ?? 5))),
    };
}

export const drawdown_regime_gate: Strategy = {
    name: 'Drawdown Regime Gate',
    description: 'Long/flat regime model using rolling drawdown stress probability and trend confirmation, with scheduled rebalancing.',
    defaultParams: {
        ddWindow: 126,
        ddDeltaWindow: 5,
        trendLen: 210,
        regimeSmooth: 8,
        entryRiskProbPct: 35,
        exitRiskProbPct: 65,
        rebalanceBars: 5,
    },
    paramLabels: {
        ddWindow: 'Drawdown Window',
        ddDeltaWindow: 'Drawdown Delta Window',
        trendLen: 'Trend EMA Length',
        regimeSmooth: 'Regime Smoothing',
        entryRiskProbPct: 'Entry Risk Probability (%)',
        exitRiskProbPct: 'Exit Risk Probability (%)',
        rebalanceBars: 'Rebalance Every N Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalize(params);
        const closes = getCloses(cleanData);
        const trend = calculateEMA(closes, cfg.trendLen);
        const slopeLookback = Math.max(3, Math.min(40, Math.round(cfg.trendLen / 8)));
        const volLookback = Math.max(10, Math.min(cfg.ddWindow, Math.round(cfg.ddWindow / 3)));

        const returns: number[] = new Array(closes.length).fill(0);
        for (let i = 1; i < closes.length; i++) {
            const prev = closes[i - 1];
            const curr = closes[i];
            if (prev > 0 && curr > 0) {
                returns[i] = Math.log(curr / prev);
            }
        }
        const realizedVol = rollingStd(returns, volLookback);

        const drawdown: number[] = new Array(closes.length).fill(0);
        for (let i = 0; i < closes.length; i++) {
            if (i < cfg.ddWindow - 1) continue;

            let peak = -Infinity;
            const start = i - cfg.ddWindow + 1;
            for (let j = start; j <= i; j++) {
                if (closes[j] > peak) peak = closes[j];
            }
            if (peak > 0) {
                drawdown[i] = Math.max(0, 1 - closes[i] / peak);
            }
        }

        const rawRiskProb: (number | null)[] = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (i < cfg.ddWindow - 1 || i < cfg.ddDeltaWindow) continue;

            const dd = drawdown[i];
            const ddDelta = Math.max(0, dd - drawdown[i - cfg.ddDeltaWindow]);
            const vol = realizedVol[i] ?? 0;
            const trendNow = trend[i];
            const trendBase = i >= slopeLookback ? trend[i - slopeLookback] : null;

            if (trendNow === null || trendBase === null) continue;
            const trendSlope = trendNow > 0 ? (trendNow - trendBase) / trendNow : 0;

            // HMM-lite stress score: downside drawdown + drawdown acceleration + realized volatility - trend support.
            const score =
                9.0 * dd +
                4.0 * ddDelta +
                8.0 * vol -
                12.0 * trendSlope;

            rawRiskProb[i] = sigmoid(score);
        }

        const riskProb: (number | null)[] = new Array(closes.length).fill(null);
        const alpha = 2 / (cfg.regimeSmooth + 1);
        let smooth: number | null = null;
        for (let i = 0; i < closes.length; i++) {
            const current = rawRiskProb[i];
            if (current === null) continue;
            smooth = smooth === null ? current : (alpha * current + (1 - alpha) * smooth);
            riskProb[i] = smooth;
        }

        const entryProb = cfg.entryRiskProbPct / 100;
        const exitProb = cfg.exitRiskProbPct / 100;
        const minBars = Math.max(cfg.ddWindow + cfg.ddDeltaWindow, cfg.trendLen + slopeLookback);

        const signals: Signal[] = [];
        let inPosition = false;
        let barsHeld = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (i < minBars) continue;
            if (i % cfg.rebalanceBars !== 0) continue;

            const prob = riskProb[i];
            const t = trend[i];
            const tBase = trend[i - slopeLookback];
            if (prob === null || t === null || tBase === null) continue;

            const trendUp = closes[i] > t && t > tBase;
            const riskOn = prob <= entryProb;
            const riskOff = prob >= exitProb;

            if (!inPosition) {
                if (trendUp && riskOn) {
                    signals.push(createBuySignal(cleanData, i, 'Drawdown regime risk-on entry'));
                    inPosition = true;
                    barsHeld = 0;
                }
                continue;
            }

            barsHeld += cfg.rebalanceBars;
            const trendFail = closes[i] < t;
            const timeExit = barsHeld >= Math.max(cfg.rebalanceBars * 3, cfg.ddDeltaWindow * 4);

            if (riskOff || trendFail || timeExit) {
                const reason = riskOff
                    ? 'Drawdown regime risk-off exit'
                    : trendFail
                        ? 'Drawdown regime trend fail exit'
                        : 'Drawdown regime time exit';
                signals.push(createSellSignal(cleanData, i, reason));
                inPosition = false;
                barsHeld = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'ddWindow',
            'ddDeltaWindow',
            'trendLen',
            'regimeSmooth',
            'entryRiskProbPct',
            'exitRiskProbPct',
            'rebalanceBars',
        ],
    },
};
