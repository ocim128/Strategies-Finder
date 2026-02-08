import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';

interface FeaturePeriods {
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    atrPeriod: number;
    adxPeriod: number;
    volumeSmaPeriod: number;
}

interface FeatureSeries {
    closes: number[];
    emaFast: (number | null)[];
    emaSlow: (number | null)[];
    rsi: (number | null)[];
    atr: (number | null)[];
    adx: (number | null)[];
    ret1: (number | null)[];
    ret5: (number | null)[];
    emaSpread: (number | null)[];
    atrPct: (number | null)[];
    volumeRel: (number | null)[];
}

interface FeatureLab1mShortConfig extends FeaturePeriods {
    slowSlopeLookback: number;
    maxSlowSlopeBps: number;
    spreadMinBps: number;
    spreadMaxBps: number;
    ret1MaxBps: number;
    ret5MaxBps: number;
    adxMin: number;
    adxMax: number;
    atrPctMinBps: number;
    volumeRelMin: number;
    volumeRelMax: number;
    rsiLow: number;
    rsiHigh: number;
    useExtremeRsi: boolean;
    useVolumeGate: boolean;
    minEntryScore: number;
    entryConfirmBars: number;
    stopAtr: number;
    targetAtr: number;
    exitRsi: number;
    maxHoldBars: number;
    cooldownBars: number;
}

interface FeatureLab7mShortConfig extends FeaturePeriods {
    slowSlopeLookback: number;
    maxSlowSlopeBps: number;
    spreadMinBps: number;
    spreadMaxBps: number;
    rsiMax: number;
    atrMidMinBps: number;
    atrMidMaxBps: number;
    atrHighMinBps: number;
    adxMidMin: number;
    adxMidMax: number;
    adxStrongMin: number;
    ret5MaxBps: number;
    volumeRelMin: number;
    useHighAtrFallback: boolean;
    minEntryScore: number;
    entryConfirmBars: number;
    stopAtr: number;
    targetAtr: number;
    exitRsi: number;
    maxHoldBars: number;
    cooldownBars: number;
}

interface FeatureLabLowVolLongConfig extends FeaturePeriods {
    slowSlopeLookback: number;
    minSlowSlopeBps: number;
    breakoutLookback: number;
    lowVolMaxBps: number;
    lowVolStreakBars: number;
    adxMaxForCompression: number;
    spreadMinBps: number;
    rsiMin: number;
    ret1MinBps: number;
    volumeRelMin: number;
    minEntryScore: number;
    entryConfirmBars: number;
    stopAtr: number;
    targetAtr: number;
    exitRsi: number;
    maxHoldBars: number;
    cooldownBars: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function asToggle(value: number | undefined, fallback: boolean): boolean {
    const raw = value ?? (fallback ? 1 : 0);
    return raw >= 0.5;
}

function toBps(value: number): number {
    return value * 10_000;
}

function buildFeatureSeries(data: OHLCVData[], periods: FeaturePeriods): FeatureSeries {
    const closes = getCloses(data);
    const highs = getHighs(data);
    const lows = getLows(data);
    const volumes = getVolumes(data);

    const emaFast = calculateEMA(closes, periods.emaFastPeriod);
    const emaSlow = calculateEMA(closes, periods.emaSlowPeriod);
    const rsi = calculateRSI(closes, periods.rsiPeriod);
    const atr = calculateATR(highs, lows, closes, periods.atrPeriod);
    const adx = calculateADX(highs, lows, closes, periods.adxPeriod);
    const volumeSma = calculateSMA(volumes, periods.volumeSmaPeriod);

    const ret1: (number | null)[] = new Array(closes.length).fill(null);
    const ret5: (number | null)[] = new Array(closes.length).fill(null);
    const emaSpread: (number | null)[] = new Array(closes.length).fill(null);
    const atrPct: (number | null)[] = new Array(closes.length).fill(null);
    const volumeRel: (number | null)[] = new Array(closes.length).fill(null);

    for (let i = 0; i < closes.length; i++) {
        const close = closes[i];
        if (close <= 0) continue;

        if (i >= 1) {
            const prev = closes[i - 1];
            if (prev > 0) ret1[i] = close / prev - 1;
        }
        if (i >= 5) {
            const prev = closes[i - 5];
            if (prev > 0) ret5[i] = close / prev - 1;
        }

        const fast = emaFast[i];
        const slow = emaSlow[i];
        if (fast !== null && slow !== null) {
            emaSpread[i] = (fast - slow) / close;
        }

        const atrValue = atr[i];
        if (atrValue !== null) {
            atrPct[i] = atrValue / close;
        }

        const volSma = volumeSma[i];
        if (volSma !== null && volSma > 0) {
            volumeRel[i] = volumes[i] / volSma;
        }
    }

    return {
        closes,
        emaFast,
        emaSlow,
        rsi,
        atr,
        adx,
        ret1,
        ret5,
        emaSpread,
        atrPct,
        volumeRel,
    };
}

function normalizeFeatureLab1mShortConfig(params: StrategyParams): FeatureLab1mShortConfig {
    const emaFastPeriod = Math.max(5, Math.min(40, Math.round(params.emaFastPeriod ?? 12)));
    const emaSlowPeriod = Math.max(emaFastPeriod + 4, Math.min(120, Math.round(params.emaSlowPeriod ?? 26)));
    const slowSlopeLookback = Math.max(3, Math.min(80, Math.round(params.slowSlopeLookback ?? Math.max(6, Math.floor(emaSlowPeriod * 0.25)))));

    const spreadMinBps = clamp(params.spreadMinBps ?? 1.4, -40, 30);
    const spreadMaxRaw = clamp(params.spreadMaxBps ?? 5.3, spreadMinBps + 0.2, 80);

    const adxMin = clamp(params.adxMin ?? 16.5, 5, 45);
    const adxMax = clamp(params.adxMax ?? 26.5, adxMin + 0.5, 70);

    const volumeRelMin = clamp(params.volumeRelMin ?? 0.85, 0.1, 5);
    const volumeRelMax = clamp(params.volumeRelMax ?? 1.45, volumeRelMin + 0.05, 20);

    const rsiLow = clamp(params.rsiLow ?? 40, 5, 60);
    const rsiHigh = clamp(params.rsiHigh ?? 60, rsiLow + 5, 95);

    return {
        emaFastPeriod,
        emaSlowPeriod,
        rsiPeriod: Math.max(5, Math.min(40, Math.round(params.rsiPeriod ?? 14))),
        atrPeriod: Math.max(5, Math.min(40, Math.round(params.atrPeriod ?? 14))),
        adxPeriod: Math.max(5, Math.min(40, Math.round(params.adxPeriod ?? 14))),
        volumeSmaPeriod: Math.max(5, Math.min(80, Math.round(params.volumeSmaPeriod ?? 20))),
        slowSlopeLookback,
        maxSlowSlopeBps: clamp(params.maxSlowSlopeBps ?? 2.5, -20, 20),
        spreadMinBps,
        spreadMaxBps: spreadMaxRaw,
        ret1MaxBps: clamp(params.ret1MaxBps ?? -5, -200, 50),
        ret5MaxBps: clamp(params.ret5MaxBps ?? -11, -500, 100),
        adxMin,
        adxMax,
        atrPctMinBps: clamp(params.atrPctMinBps ?? 12, 1, 500),
        volumeRelMin,
        volumeRelMax,
        rsiLow,
        rsiHigh,
        useExtremeRsi: asToggle(params.useExtremeRsi, true),
        useVolumeGate: asToggle(params.useVolumeGate, true),
        minEntryScore: clamp(params.minEntryScore ?? 3.25, 1.2, 8),
        entryConfirmBars: Math.max(1, Math.min(6, Math.round(params.entryConfirmBars ?? 1))),
        stopAtr: clamp(params.stopAtr ?? 1.55, 0.4, 6),
        targetAtr: clamp(params.targetAtr ?? 1.15, 0.3, 8),
        exitRsi: clamp(params.exitRsi ?? 52, 25, 85),
        maxHoldBars: Math.max(2, Math.min(200, Math.round(params.maxHoldBars ?? 16))),
        cooldownBars: Math.max(0, Math.min(120, Math.round(params.cooldownBars ?? 3))),
    };
}

function normalizeFeatureLab7mShortConfig(params: StrategyParams): FeatureLab7mShortConfig {
    const emaFastPeriod = Math.max(5, Math.min(50, Math.round(params.emaFastPeriod ?? 12)));
    const emaSlowPeriod = Math.max(emaFastPeriod + 4, Math.min(180, Math.round(params.emaSlowPeriod ?? 34)));
    const slowSlopeLookback = Math.max(5, Math.min(120, Math.round(params.slowSlopeLookback ?? Math.max(8, Math.floor(emaSlowPeriod * 0.3)))));

    const spreadMinBps = clamp(params.spreadMinBps ?? -48, -200, -1);
    const spreadMaxBps = clamp(params.spreadMaxBps ?? -2.8, spreadMinBps + 0.2, 5);

    const atrMidMinBps = clamp(params.atrMidMinBps ?? 15.2, 2, 300);
    const atrMidMaxBps = clamp(params.atrMidMaxBps ?? 22.2, atrMidMinBps + 0.2, 500);

    const adxMidMin = clamp(params.adxMidMin ?? 21, 5, 70);
    const adxMidMax = clamp(params.adxMidMax ?? 26.5, adxMidMin + 0.5, 90);

    return {
        emaFastPeriod,
        emaSlowPeriod,
        rsiPeriod: Math.max(5, Math.min(40, Math.round(params.rsiPeriod ?? 14))),
        atrPeriod: Math.max(5, Math.min(40, Math.round(params.atrPeriod ?? 14))),
        adxPeriod: Math.max(5, Math.min(40, Math.round(params.adxPeriod ?? 14))),
        volumeSmaPeriod: Math.max(5, Math.min(100, Math.round(params.volumeSmaPeriod ?? 20))),
        slowSlopeLookback,
        maxSlowSlopeBps: clamp(params.maxSlowSlopeBps ?? -1, -40, 20),
        spreadMinBps,
        spreadMaxBps,
        rsiMax: clamp(params.rsiMax ?? 41, 10, 70),
        atrMidMinBps,
        atrMidMaxBps,
        atrHighMinBps: clamp(params.atrHighMinBps ?? 28, atrMidMaxBps, 800),
        adxMidMin,
        adxMidMax,
        adxStrongMin: clamp(params.adxStrongMin ?? 34, adxMidMax, 100),
        ret5MaxBps: clamp(params.ret5MaxBps ?? -6.5, -600, 100),
        volumeRelMin: clamp(params.volumeRelMin ?? 1, 0.1, 10),
        useHighAtrFallback: asToggle(params.useHighAtrFallback, true),
        minEntryScore: clamp(params.minEntryScore ?? 3.1, 1.2, 8),
        entryConfirmBars: Math.max(1, Math.min(8, Math.round(params.entryConfirmBars ?? 1))),
        stopAtr: clamp(params.stopAtr ?? 1.7, 0.4, 6),
        targetAtr: clamp(params.targetAtr ?? 1.25, 0.3, 8),
        exitRsi: clamp(params.exitRsi ?? 50, 20, 85),
        maxHoldBars: Math.max(3, Math.min(260, Math.round(params.maxHoldBars ?? 24))),
        cooldownBars: Math.max(0, Math.min(160, Math.round(params.cooldownBars ?? 5))),
    };
}

function normalizeFeatureLabLowVolLongConfig(params: StrategyParams): FeatureLabLowVolLongConfig {
    const emaFastPeriod = Math.max(5, Math.min(60, Math.round(params.emaFastPeriod ?? 12)));
    const emaSlowPeriod = Math.max(emaFastPeriod + 5, Math.min(220, Math.round(params.emaSlowPeriod ?? 34)));
    const slowSlopeLookback = Math.max(5, Math.min(120, Math.round(params.slowSlopeLookback ?? Math.max(8, Math.floor(emaSlowPeriod * 0.3)))));

    return {
        emaFastPeriod,
        emaSlowPeriod,
        rsiPeriod: Math.max(5, Math.min(40, Math.round(params.rsiPeriod ?? 14))),
        atrPeriod: Math.max(5, Math.min(40, Math.round(params.atrPeriod ?? 14))),
        adxPeriod: Math.max(5, Math.min(40, Math.round(params.adxPeriod ?? 14))),
        volumeSmaPeriod: Math.max(5, Math.min(120, Math.round(params.volumeSmaPeriod ?? 20))),
        slowSlopeLookback,
        minSlowSlopeBps: clamp(params.minSlowSlopeBps ?? 0.5, -20, 40),
        breakoutLookback: Math.max(3, Math.min(80, Math.round(params.breakoutLookback ?? 12))),
        lowVolMaxBps: clamp(params.lowVolMaxBps ?? 15.5, 1, 300),
        lowVolStreakBars: Math.max(2, Math.min(60, Math.round(params.lowVolStreakBars ?? 6))),
        adxMaxForCompression: clamp(params.adxMaxForCompression ?? 22, 5, 60),
        spreadMinBps: clamp(params.spreadMinBps ?? 0.5, -30, 80),
        rsiMin: clamp(params.rsiMin ?? 52, 20, 90),
        ret1MinBps: clamp(params.ret1MinBps ?? 1.5, -200, 200),
        volumeRelMin: clamp(params.volumeRelMin ?? 0.95, 0.05, 10),
        minEntryScore: clamp(params.minEntryScore ?? 3.2, 1.2, 8),
        entryConfirmBars: Math.max(1, Math.min(8, Math.round(params.entryConfirmBars ?? 1))),
        stopAtr: clamp(params.stopAtr ?? 1.45, 0.4, 8),
        targetAtr: clamp(params.targetAtr ?? 1.75, 0.3, 12),
        exitRsi: clamp(params.exitRsi ?? 45, 5, 80),
        maxHoldBars: Math.max(3, Math.min(320, Math.round(params.maxHoldBars ?? 44))),
        cooldownBars: Math.max(0, Math.min(220, Math.round(params.cooldownBars ?? 6))),
    };
}

export const feature_lab_1m_short_pressure: Strategy = {
    name: 'Feature Lab 1m Short Pressure',
    description: 'Short-side pressure strategy tuned for walk-forward stability: short-return weakness + verdict feature bins with trend-slope risk gating.',
    defaultParams: {
        emaFastPeriod: 12,
        emaSlowPeriod: 26,
        rsiPeriod: 14,
        atrPeriod: 14,
        adxPeriod: 14,
        volumeSmaPeriod: 20,
        slowSlopeLookback: 8,
        maxSlowSlopeBps: 2.5,
        spreadMinBps: 1.4,
        spreadMaxBps: 5.3,
        ret1MaxBps: -5,
        ret5MaxBps: -11,
        adxMin: 16.5,
        adxMax: 26.5,
        atrPctMinBps: 12,
        volumeRelMin: 0.85,
        volumeRelMax: 1.45,
        rsiLow: 40,
        rsiHigh: 60,
        useExtremeRsi: 1,
        useVolumeGate: 1,
        minEntryScore: 3.25,
        entryConfirmBars: 1,
        stopAtr: 1.55,
        targetAtr: 1.15,
        exitRsi: 52,
        maxHoldBars: 16,
        cooldownBars: 3,
    },
    paramLabels: {
        emaFastPeriod: 'Fast EMA Period',
        emaSlowPeriod: 'Slow EMA Period',
        rsiPeriod: 'RSI Period',
        atrPeriod: 'ATR Period',
        adxPeriod: 'ADX Period',
        volumeSmaPeriod: 'Volume SMA Period',
        slowSlopeLookback: 'Slow EMA Slope Lookback',
        maxSlowSlopeBps: 'Slow EMA Slope Max (bps)',
        spreadMinBps: 'EMA Spread Min (bps)',
        spreadMaxBps: 'EMA Spread Max (bps)',
        ret1MaxBps: '1-Bar Return Max (bps)',
        ret5MaxBps: '5-Bar Return Max (bps)',
        adxMin: 'ADX Min',
        adxMax: 'ADX Max',
        atrPctMinBps: 'ATR% Min (bps)',
        volumeRelMin: 'Volume Rel Min',
        volumeRelMax: 'Volume Rel Max',
        rsiLow: 'RSI Low Extreme',
        rsiHigh: 'RSI High Extreme',
        useExtremeRsi: 'Use RSI Extremes (0/1)',
        useVolumeGate: 'Use Volume Gate (0/1)',
        minEntryScore: 'Entry Score Threshold',
        entryConfirmBars: 'Entry Confirm Bars',
        stopAtr: 'Stop ATR',
        targetAtr: 'Target ATR',
        exitRsi: 'Exit RSI',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeFeatureLab1mShortConfig(params);
        const minBars = Math.max(cfg.emaSlowPeriod + cfg.slowSlopeLookback + 5, cfg.adxPeriod * 2 + 2, cfg.volumeSmaPeriod + 2, 30);
        if (cleanData.length < minBars) return [];

        const series = buildFeatureSeries(cleanData, cfg);
        const signals: Signal[] = [];

        let inPosition = false;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let entryStreak = 0;
        let lowSinceEntry = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const close = series.closes[i];
            const emaFast = series.emaFast[i];
            const emaSlow = series.emaSlow[i];
            const rsi = series.rsi[i];
            const atr = series.atr[i];
            const adx = series.adx[i];
            const ret1 = series.ret1[i];
            const ret5 = series.ret5[i];
            const spread = series.emaSpread[i];
            const atrPct = series.atrPct[i];
            const volumeRel = series.volumeRel[i];

            if (
                emaFast === null ||
                emaSlow === null ||
                rsi === null ||
                atr === null ||
                atr <= 0 ||
                adx === null ||
                ret1 === null ||
                ret5 === null ||
                spread === null ||
                atrPct === null ||
                volumeRel === null
            ) {
                continue;
            }

            const spreadBps = toBps(spread);
            const ret1Bps = toBps(ret1);
            const ret5Bps = toBps(ret5);
            const atrPctBps = toBps(atrPct);
            const slowBase = i >= cfg.slowSlopeLookback ? series.emaSlow[i - cfg.slowSlopeLookback] : null;
            const slowSlopeBps = slowBase !== null && close > 0 ? toBps((emaSlow - slowBase) / close) : null;

            const spreadPass = (spreadBps >= cfg.spreadMinBps && spreadBps <= cfg.spreadMaxBps) || spreadBps <= -6;
            const returnsPass = ret1Bps <= cfg.ret1MaxBps || ret5Bps <= cfg.ret5MaxBps;
            const adxPass = (adx >= cfg.adxMin && adx <= cfg.adxMax) || adx >= cfg.adxMax + 6;
            const atrPass = atrPctBps >= cfg.atrPctMinBps;
            const volumePass = volumeRel >= cfg.volumeRelMin && volumeRel <= cfg.volumeRelMax;
            const rsiExtreme = rsi <= cfg.rsiLow || rsi >= cfg.rsiHigh;
            const trendPass = close <= emaSlow || slowSlopeBps === null || slowSlopeBps <= cfg.maxSlowSlopeBps;

            let score = 0;
            if (spreadPass) score += 1.45;
            if (returnsPass) score += 1.25;
            if (adxPass) score += 0.95;
            if (atrPass) score += 0.75;
            if (!cfg.useVolumeGate || volumePass) score += 0.45;
            if (!cfg.useExtremeRsi || rsiExtreme) score += 0.45;
            if (close <= emaFast * 1.0025) score += 0.6;
            if (trendPass) score += 0.85;

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                entryStreak = score >= cfg.minEntryScore ? entryStreak + 1 : 0;
                if (entryStreak >= cfg.entryConfirmBars && trendPass) {
                    signals.push(createSellSignal(cleanData, i, 'FeatureLab 1m short pressure entry'));
                    inPosition = true;
                    entryPrice = close;
                    entryAtr = atr;
                    barsHeld = 0;
                    entryStreak = 0;
                    lowSinceEntry = close;
                }
                continue;
            }

            barsHeld++;
            if (close < lowSinceEntry) lowSinceEntry = close;
            const trailStop = lowSinceEntry + Math.max(0.25, cfg.stopAtr * 0.55) * entryAtr;

            const stopHit = close >= entryPrice + cfg.stopAtr * entryAtr || (barsHeld > 2 && close >= trailStop);
            const targetHit = close <= entryPrice - cfg.targetAtr * entryAtr;
            const pressureFade = rsi >= cfg.exitRsi && close > emaFast * 1.001;
            const timeStop = barsHeld >= cfg.maxHoldBars;

            if (stopHit || targetHit || pressureFade || timeStop) {
                signals.push(createBuySignal(cleanData, i, stopHit ? 'FeatureLab 1m short stop' : targetHit ? 'FeatureLab 1m short target' : pressureFade ? 'FeatureLab 1m short pressure fade' : 'FeatureLab 1m short time stop'));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                cooldown = cfg.cooldownBars;
                entryStreak = 0;
                lowSinceEntry = 0;
            }
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createBuySignal(cleanData, cleanData.length - 1, 'FeatureLab 1m short final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'short',
        walkForwardParams: [
            'spreadMinBps',
            'ret5MaxBps',
            'adxMin',
            'atrPctMinBps',
            'minEntryScore',
            'stopAtr',
            'targetAtr',
            'maxHoldBars',
        ],
    },
};

export const feature_lab_7m_short_pressure: Strategy = {
    name: 'Feature Lab 7m Short Pressure',
    description: '7m downside continuation strategy with slower trend-slope gate, verdict feature pressure score, and tighter risk exits.',
    defaultParams: {
        emaFastPeriod: 12,
        emaSlowPeriod: 34,
        rsiPeriod: 14,
        atrPeriod: 14,
        adxPeriod: 14,
        volumeSmaPeriod: 20,
        slowSlopeLookback: 10,
        maxSlowSlopeBps: -1,
        spreadMinBps: -48,
        spreadMaxBps: -2.8,
        rsiMax: 41,
        atrMidMinBps: 15.2,
        atrMidMaxBps: 22.2,
        atrHighMinBps: 28,
        adxMidMin: 21,
        adxMidMax: 26.5,
        adxStrongMin: 34,
        ret5MaxBps: -6.5,
        volumeRelMin: 1,
        useHighAtrFallback: 1,
        minEntryScore: 3.1,
        entryConfirmBars: 1,
        stopAtr: 1.7,
        targetAtr: 1.25,
        exitRsi: 50,
        maxHoldBars: 24,
        cooldownBars: 5,
    },
    paramLabels: {
        emaFastPeriod: 'Fast EMA Period',
        emaSlowPeriod: 'Slow EMA Period',
        rsiPeriod: 'RSI Period',
        atrPeriod: 'ATR Period',
        adxPeriod: 'ADX Period',
        volumeSmaPeriod: 'Volume SMA Period',
        slowSlopeLookback: 'Slow EMA Slope Lookback',
        maxSlowSlopeBps: 'Slow EMA Slope Max (bps)',
        spreadMinBps: 'EMA Spread Min (bps)',
        spreadMaxBps: 'EMA Spread Max (bps)',
        rsiMax: 'RSI Max',
        atrMidMinBps: 'ATR Mid Min (bps)',
        atrMidMaxBps: 'ATR Mid Max (bps)',
        atrHighMinBps: 'ATR High Min (bps)',
        adxMidMin: 'ADX Mid Min',
        adxMidMax: 'ADX Mid Max',
        adxStrongMin: 'ADX Strong Min',
        ret5MaxBps: '5-Bar Return Max (bps)',
        volumeRelMin: 'Volume Rel Min',
        useHighAtrFallback: 'Use High ATR Fallback (0/1)',
        minEntryScore: 'Entry Score Threshold',
        entryConfirmBars: 'Entry Confirm Bars',
        stopAtr: 'Stop ATR',
        targetAtr: 'Target ATR',
        exitRsi: 'Exit RSI',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeFeatureLab7mShortConfig(params);
        const minBars = Math.max(cfg.emaSlowPeriod + cfg.slowSlopeLookback + 5, cfg.adxPeriod * 2 + 2, cfg.volumeSmaPeriod + 2, 40);
        if (cleanData.length < minBars) return [];

        const series = buildFeatureSeries(cleanData, cfg);
        const signals: Signal[] = [];

        let inPosition = false;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let entryStreak = 0;
        let lowSinceEntry = 0;
        let bestMove = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const close = series.closes[i];
            const emaFast = series.emaFast[i];
            const emaSlow = series.emaSlow[i];
            const rsi = series.rsi[i];
            const atr = series.atr[i];
            const adx = series.adx[i];
            const adxPrev = series.adx[i - 1];
            const ret5 = series.ret5[i];
            const spread = series.emaSpread[i];
            const atrPct = series.atrPct[i];
            const atrPctPrev = series.atrPct[i - 1];
            const volumeRel = series.volumeRel[i];

            if (
                emaFast === null ||
                emaSlow === null ||
                rsi === null ||
                atr === null ||
                atr <= 0 ||
                adx === null ||
                adxPrev === null ||
                ret5 === null ||
                spread === null ||
                atrPct === null ||
                atrPctPrev === null ||
                volumeRel === null
            ) {
                continue;
            }

            const spreadBps = toBps(spread);
            const ret5Bps = toBps(ret5);
            const atrPctBps = toBps(atrPct);
            const atrSlopeBps = toBps(atrPct - atrPctPrev);
            const slowBase = i >= cfg.slowSlopeLookback ? series.emaSlow[i - cfg.slowSlopeLookback] : null;
            const slowSlopeBps = slowBase !== null && close > 0 ? toBps((emaSlow - slowBase) / close) : null;
            const adxSlope = adx - adxPrev;

            const spreadPass = spreadBps >= cfg.spreadMinBps && spreadBps <= cfg.spreadMaxBps;
            const rsiPass = rsi <= cfg.rsiMax;
            const atrMidPass = atrPctBps >= cfg.atrMidMinBps && atrPctBps <= cfg.atrMidMaxBps;
            const atrHighPass = cfg.useHighAtrFallback && atrPctBps >= cfg.atrHighMinBps;
            const adxMidPass = adx >= cfg.adxMidMin && adx <= cfg.adxMidMax;
            const adxStrongPass = adx >= cfg.adxStrongMin;
            const downReturnPass = ret5Bps <= cfg.ret5MaxBps;
            const volumePass = volumeRel >= cfg.volumeRelMin;
            const trendPass = close <= emaSlow && (slowSlopeBps === null || slowSlopeBps <= cfg.maxSlowSlopeBps);
            const atrFallbackPass = !atrMidPass && atrHighPass && adxMidPass && adxSlope >= -0.05;
            const regimePass = (atrMidPass && (adxMidPass || adxStrongPass)) || atrFallbackPass;
            const structuralPass = trendPass && spreadPass && downReturnPass;
            const confirmationPass = rsiPass && volumePass && close < emaFast && adxSlope >= -0.15;
            const oversoldExhaustion = rsi < Math.max(14, cfg.rsiMax * 0.42);
            const extensionAtr = (emaFast - close) / atr;
            const notOverextended = extensionAtr <= Math.max(0.65, cfg.targetAtr * 0.9);

            let score = 0;
            if (spreadPass) score += 1.35;
            if (rsiPass) score += 1.05;
            if (atrMidPass) score += 0.9;
            if (!atrMidPass && atrHighPass) score += 0.55;
            if (adxStrongPass) score += 0.75;
            if (!adxStrongPass && adxMidPass) score += 0.45;
            if (downReturnPass) score += 0.8;
            if (volumePass) score += 0.4;
            if (trendPass) score += 0.9;
            if (close < emaFast) score += 0.5;
            if (regimePass) score += 0.45;
            if (structuralPass) score += 0.55;
            if (adxSlope > 0) score += 0.45;
            if (atrSlopeBps > 0) score += 0.35;
            if (notOverextended) score += 0.35;
            if (oversoldExhaustion && !adxStrongPass) score -= 0.8;
            if (!confirmationPass) score -= 0.9;

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                const fallbackMode = atrFallbackPass;
                const requiredStreak = cfg.entryConfirmBars + (fallbackMode ? 1 : 0);
                const entryGate =
                    structuralPass &&
                    regimePass &&
                    confirmationPass &&
                    notOverextended &&
                    (!oversoldExhaustion || adxStrongPass) &&
                    adxSlope > -0.15 &&
                    atrSlopeBps > -2.5;

                entryStreak = score >= cfg.minEntryScore && entryGate ? entryStreak + 1 : 0;
                if (entryStreak >= requiredStreak) {
                    signals.push(createSellSignal(cleanData, i, 'FeatureLab 7m short pressure entry'));
                    inPosition = true;
                    entryPrice = close;
                    entryAtr = atr;
                    barsHeld = 0;
                    entryStreak = 0;
                    lowSinceEntry = close;
                    bestMove = 0;
                }
                continue;
            }

            barsHeld++;
            if (close < lowSinceEntry) lowSinceEntry = close;
            const favorableMove = entryPrice - close;
            if (favorableMove > bestMove) bestMove = favorableMove;

            const tightenedTrail = bestMove >= cfg.targetAtr * 0.65 * entryAtr;
            const trailMult = tightenedTrail ? Math.max(0.22, cfg.stopAtr * 0.45) : Math.max(0.3, cfg.stopAtr * 0.6);
            const trailStop = lowSinceEntry + trailMult * entryAtr;
            const earlyWindow = Math.max(2, Math.min(8, Math.round(cfg.maxHoldBars * 0.2)));

            const stopHit = close >= entryPrice + cfg.stopAtr * entryAtr || (barsHeld > 2 && close >= trailStop);
            const targetHit = close <= entryPrice - cfg.targetAtr * entryAtr;
            const trendFail = (rsi >= cfg.exitRsi && close > emaFast) || (slowSlopeBps !== null && slowSlopeBps > cfg.maxSlowSlopeBps + 1.5);
            const failedBreakdown = barsHeld <= earlyWindow && close >= entryPrice + Math.max(0.25, cfg.stopAtr * 0.35) * entryAtr;
            const adxFade = barsHeld >= 2 && adx < cfg.adxMidMin && adxSlope < -0.2;
            const reboundRisk = rsi >= cfg.exitRsi - 2 && close > emaFast;
            const timeStop = barsHeld >= cfg.maxHoldBars;

            if (stopHit || targetHit || trendFail || failedBreakdown || adxFade || reboundRisk || timeStop) {
                const reason = stopHit
                    ? 'FeatureLab 7m short stop'
                    : targetHit
                        ? 'FeatureLab 7m short target'
                        : trendFail
                            ? 'FeatureLab 7m short trend fail'
                            : failedBreakdown
                                ? 'FeatureLab 7m short failed breakdown'
                                : adxFade
                                    ? 'FeatureLab 7m short adx fade'
                                    : reboundRisk
                                        ? 'FeatureLab 7m short rebound risk'
                                        : 'FeatureLab 7m short time stop';
                signals.push(createBuySignal(cleanData, i, reason));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                cooldown = stopHit || failedBreakdown ? cfg.cooldownBars + 1 : cfg.cooldownBars;
                entryStreak = 0;
                lowSinceEntry = 0;
                bestMove = 0;
            }
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createBuySignal(cleanData, cleanData.length - 1, 'FeatureLab 7m short final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'short',
        walkForwardParams: [
            'spreadMinBps',
            'rsiMax',
            'atrMidMinBps',
            'adxStrongMin',
            'ret5MaxBps',
            'minEntryScore',
            'stopAtr',
            'targetAtr',
            'maxHoldBars',
        ],
    },
};

export const feature_lab_7m_low_vol_expansion: Strategy = {
    name: 'Feature Lab 7m Low-Vol Expansion',
    description: 'Long-only compression breakout strategy built from the robust low-ATR verdict regime with trend-slope and breakout filters.',
    defaultParams: {
        emaFastPeriod: 12,
        emaSlowPeriod: 34,
        rsiPeriod: 14,
        atrPeriod: 14,
        adxPeriod: 14,
        volumeSmaPeriod: 20,
        slowSlopeLookback: 10,
        minSlowSlopeBps: 0.5,
        breakoutLookback: 12,
        lowVolMaxBps: 15.5,
        lowVolStreakBars: 6,
        adxMaxForCompression: 22,
        spreadMinBps: 0.5,
        rsiMin: 52,
        ret1MinBps: 1.5,
        volumeRelMin: 0.95,
        minEntryScore: 3.2,
        entryConfirmBars: 1,
        stopAtr: 1.45,
        targetAtr: 1.75,
        exitRsi: 45,
        maxHoldBars: 44,
        cooldownBars: 6,
    },
    paramLabels: {
        emaFastPeriod: 'Fast EMA Period',
        emaSlowPeriod: 'Slow EMA Period',
        rsiPeriod: 'RSI Period',
        atrPeriod: 'ATR Period',
        adxPeriod: 'ADX Period',
        volumeSmaPeriod: 'Volume SMA Period',
        slowSlopeLookback: 'Slow EMA Slope Lookback',
        minSlowSlopeBps: 'Slow EMA Slope Min (bps)',
        breakoutLookback: 'Breakout Lookback',
        lowVolMaxBps: 'Low Vol Max (bps)',
        lowVolStreakBars: 'Compression Streak Bars',
        adxMaxForCompression: 'Compression ADX Max',
        spreadMinBps: 'EMA Spread Min (bps)',
        rsiMin: 'RSI Min',
        ret1MinBps: '1-Bar Return Min (bps)',
        volumeRelMin: 'Volume Rel Min',
        minEntryScore: 'Entry Score Threshold',
        entryConfirmBars: 'Entry Confirm Bars',
        stopAtr: 'Stop ATR',
        targetAtr: 'Target ATR',
        exitRsi: 'Exit RSI',
        maxHoldBars: 'Max Hold Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalizeFeatureLabLowVolLongConfig(params);
        const minBars = Math.max(cfg.emaSlowPeriod + cfg.slowSlopeLookback + 5, cfg.adxPeriod * 2 + 2, cfg.volumeSmaPeriod + 2, cfg.lowVolStreakBars + cfg.breakoutLookback + 4);
        if (cleanData.length < minBars) return [];

        const series = buildFeatureSeries(cleanData, cfg);
        const signals: Signal[] = [];

        let inPosition = false;
        let entryPrice = 0;
        let entryAtr = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let entryStreak = 0;
        let lowVolStreak = 0;
        let highSinceEntry = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const close = series.closes[i];
            const emaFast = series.emaFast[i];
            const emaSlow = series.emaSlow[i];
            const rsi = series.rsi[i];
            const atr = series.atr[i];
            const adx = series.adx[i];
            const ret1 = series.ret1[i];
            const spread = series.emaSpread[i];
            const atrPct = series.atrPct[i];
            const volumeRel = series.volumeRel[i];

            if (
                emaFast === null ||
                emaSlow === null ||
                rsi === null ||
                atr === null ||
                atr <= 0 ||
                adx === null ||
                ret1 === null ||
                spread === null ||
                atrPct === null ||
                volumeRel === null
            ) {
                continue;
            }

            const atrPctBps = toBps(atrPct);
            const spreadBps = toBps(spread);
            const ret1Bps = toBps(ret1);
            const slowBase = i >= cfg.slowSlopeLookback ? series.emaSlow[i - cfg.slowSlopeLookback] : null;
            const slowSlopeBps = slowBase !== null && close > 0 ? toBps((emaSlow - slowBase) / close) : null;

            let priorHigh = -Infinity;
            const breakoutStart = Math.max(0, i - cfg.breakoutLookback);
            for (let j = breakoutStart; j < i; j++) {
                if (series.closes[j] > priorHigh) priorHigh = series.closes[j];
            }
            const breakoutReady = Number.isFinite(priorHigh) && close > priorHigh;

            const compressionBar = atrPctBps <= cfg.lowVolMaxBps && adx <= cfg.adxMaxForCompression;
            if (compressionBar) {
                lowVolStreak++;
            } else {
                lowVolStreak = Math.max(0, lowVolStreak - 1);
            }

            const compressionReady = lowVolStreak >= cfg.lowVolStreakBars;
            const trendReady = close > emaFast && emaFast > emaSlow && spreadBps >= cfg.spreadMinBps;
            const slopeReady = slowSlopeBps === null || slowSlopeBps >= cfg.minSlowSlopeBps;
            const momentumReady = rsi >= cfg.rsiMin && ret1Bps >= cfg.ret1MinBps;
            const volumeReady = volumeRel >= cfg.volumeRelMin;

            let score = 0;
            if (compressionReady) score += 1.15;
            if (trendReady) score += 0.95;
            if (slopeReady) score += 0.9;
            if (momentumReady) score += 0.95;
            if (volumeReady) score += 0.45;
            if (breakoutReady) score += 0.75;
            if (close > series.closes[i - 1]) score += 0.35;

            if (!inPosition) {
                if (cooldown > 0) {
                    cooldown--;
                    continue;
                }

                entryStreak = score >= cfg.minEntryScore ? entryStreak + 1 : 0;
                if (entryStreak >= cfg.entryConfirmBars && slopeReady && breakoutReady) {
                    signals.push(createBuySignal(cleanData, i, 'FeatureLab 7m low-vol expansion entry'));
                    inPosition = true;
                    entryPrice = close;
                    entryAtr = atr;
                    barsHeld = 0;
                    entryStreak = 0;
                    lowVolStreak = 0;
                    highSinceEntry = close;
                }
                continue;
            }

            barsHeld++;
            if (close > highSinceEntry) highSinceEntry = close;
            const trailStop = highSinceEntry - Math.max(0.3, cfg.stopAtr * 0.65) * entryAtr;

            const stopHit = close <= entryPrice - cfg.stopAtr * entryAtr || (barsHeld > 2 && close <= trailStop);
            const targetHit = close >= entryPrice + cfg.targetAtr * entryAtr;
            const trendFail = (close < emaFast && rsi <= cfg.exitRsi) || (slowSlopeBps !== null && slowSlopeBps < cfg.minSlowSlopeBps - 1.5);
            const timeStop = barsHeld >= cfg.maxHoldBars;

            if (stopHit || targetHit || trendFail || timeStop) {
                signals.push(createSellSignal(cleanData, i, stopHit ? 'FeatureLab 7m low-vol stop' : targetHit ? 'FeatureLab 7m low-vol target' : trendFail ? 'FeatureLab 7m low-vol trend fail' : 'FeatureLab 7m low-vol time stop'));
                inPosition = false;
                entryPrice = 0;
                entryAtr = 0;
                barsHeld = 0;
                cooldown = cfg.cooldownBars;
                entryStreak = 0;
                highSinceEntry = 0;
            }
        }

        if (inPosition && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'FeatureLab 7m low-vol final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'long',
        walkForwardParams: [
            'lowVolMaxBps',
            'lowVolStreakBars',
            'minSlowSlopeBps',
            'rsiMin',
            'minEntryScore',
            'stopAtr',
            'targetAtr',
            'maxHoldBars',
        ],
    },
};
