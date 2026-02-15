import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateSMA, calculateADX } from '../indicators';
import { fib_speed_fan_entry } from './fib-speed-fan-entry';

interface Config {
    depth: number;
    atrPeriod: number;
    deviationMult: number;
    levelIndex: number;
    entryMode: number;
    touchUsesWick: number;
    touchTolerancePct: number;
    usePivotContext: number;
    useLong: number;
    useShort: number;
    signalCooldownBars: number;
    trailAtr: number;
    initialStopAtr: number;
    maxHoldBars: number;
    killIfNoProfitAfterBars: number;
    entryCooldownBars: number;
    atrGateMaPeriod: number;
    tradeCapWindowBars: number;
    maxEntriesPerWindow: number;
    trendSmaPeriod: number;
    adxPeriod: number;
    adxTrendThreshold: number;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

function intClamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function normalize(params: StrategyParams): Config {
    return {
        depth: intClamp(params.depth ?? 11, 3, 80),
        atrPeriod: intClamp(params.atrPeriod ?? 14, 3, 100),
        deviationMult: clamp(params.deviationMult ?? 3, 0.5, 8),
        levelIndex: intClamp(params.levelIndex ?? 3, 0, 4),
        entryMode: intClamp(params.entryMode ?? 0, 0, 2),
        touchUsesWick: intClamp(params.touchUsesWick ?? 1, 0, 1),
        touchTolerancePct: clamp(params.touchTolerancePct ?? 0.05, 0, 1),
        usePivotContext: intClamp(params.usePivotContext ?? 1, 0, 1),
        useLong: intClamp(params.useLong ?? 1, 0, 1),
        useShort: intClamp(params.useShort ?? 1, 0, 1),
        signalCooldownBars: intClamp(params.signalCooldownBars ?? 6, 0, 200),
        trailAtr: clamp(params.trailAtr ?? 2.2, 0.2, 12),
        initialStopAtr: clamp(params.initialStopAtr ?? 1.5, 0.2, 12),
        maxHoldBars: intClamp(params.maxHoldBars ?? 36, 2, 300),
        killIfNoProfitAfterBars: intClamp(params.killIfNoProfitAfterBars ?? 12, 1, 200),
        entryCooldownBars: intClamp(params.entryCooldownBars ?? 4, 0, 200),
        atrGateMaPeriod: intClamp(params.atrGateMaPeriod ?? 20, 5, 120),
        tradeCapWindowBars: intClamp(params.tradeCapWindowBars ?? 18, 4, 200),
        maxEntriesPerWindow: intClamp(params.maxEntriesPerWindow ?? 2, 1, 12),
        trendSmaPeriod: intClamp(params.trendSmaPeriod ?? 50, 20, 200),
        adxPeriod: intClamp(params.adxPeriod ?? 14, 5, 50),
        adxTrendThreshold: clamp(params.adxTrendThreshold ?? 25, 10, 60),
    };
}

function toFibParams(config: Config): StrategyParams {
    return {
        depth: config.depth,
        atrPeriod: config.atrPeriod,
        deviationMult: config.deviationMult,
        levelIndex: config.levelIndex,
        entryMode: config.entryMode,
        retestMode: 2,
        targetPct: 0,
        touchUsesWick: config.touchUsesWick,
        touchTolerancePct: config.touchTolerancePct,
        usePivotContext: config.usePivotContext,
        useLong: config.useLong,
        useShort: config.useShort,
        signalCooldownBars: config.signalCooldownBars,
        maxBars: 50,
        maxRetests: 3,
        minRetestsForWin: 1,
    };
}

export const meta_harvest_v2_2: Strategy = {
    name: 'Meta Harvest v2.2',
    description: 'Meta Harvest with hybrid entry permission: ATR expansion OR strong trend bypass, plus rolling trade-frequency cap.',
    defaultParams: {
        depth: 11,
        atrPeriod: 14,
        deviationMult: 3,
        levelIndex: 3,
        entryMode: 0,
        touchUsesWick: 1,
        touchTolerancePct: 0.05,
        usePivotContext: 1,
        useLong: 1,
        useShort: 1,
        signalCooldownBars: 6,
        trailAtr: 2.2,
        initialStopAtr: 1.5,
        maxHoldBars: 36,
        killIfNoProfitAfterBars: 12,
        entryCooldownBars: 4,
        atrGateMaPeriod: 20,
        tradeCapWindowBars: 18,
        maxEntriesPerWindow: 2,
        trendSmaPeriod: 50,
        adxPeriod: 14,
        adxTrendThreshold: 25,
    },
    paramLabels: {
        depth: 'Pivot Depth',
        atrPeriod: 'ATR Period',
        deviationMult: 'Deviation Multiplier',
        levelIndex: 'Fib Level Index (0-4)',
        entryMode: 'Entry Mode',
        touchUsesWick: 'Touch Uses Wick (0/1)',
        touchTolerancePct: 'Touch Tolerance %',
        usePivotContext: 'Use Pivot Context (0/1)',
        useLong: 'Enable Long (0/1)',
        useShort: 'Enable Short (0/1)',
        signalCooldownBars: 'Fib Signal Cooldown',
        trailAtr: 'ATR Trailing Stop',
        initialStopAtr: 'Initial Stop ATR',
        maxHoldBars: 'Max Hold Bars',
        killIfNoProfitAfterBars: 'Kill If No Profit After Bars',
        entryCooldownBars: 'Post-Exit Cooldown Bars',
        atrGateMaPeriod: 'ATR Gate MA Period',
        tradeCapWindowBars: 'Trade Cap Window Bars',
        maxEntriesPerWindow: 'Max Entries Per Window',
        trendSmaPeriod: 'Trend SMA Period',
        adxPeriod: 'ADX Period',
        adxTrendThreshold: 'ADX Trend Threshold',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalize(params);
        const fibSignals = fib_speed_fan_entry.execute(cleanData, toFibParams(cfg))
            .slice()
            .sort((a, b) => {
                const ai = typeof a.barIndex === 'number' ? a.barIndex : 0;
                const bi = typeof b.barIndex === 'number' ? b.barIndex : 0;
                return ai - bi;
            });

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, cfg.atrPeriod);
        const atrBase = atr.map((value) => (value === null ? 0 : value));
        const atrMa = calculateSMA(atrBase, cfg.atrGateMaPeriod);
        const trendSma = calculateSMA(closes, cfg.trendSmaPeriod);
        const adx = calculateADX(getHighs(cleanData), getLows(cleanData), closes, cfg.adxPeriod);

        const signalByIndex = new Map<number, { buy: boolean; sell: boolean; reasonBuy?: string; reasonSell?: string }>();
        for (const signal of fibSignals) {
            const index = typeof signal.barIndex === 'number' ? signal.barIndex : -1;
            if (index < 0 || index >= cleanData.length) continue;
            const row = signalByIndex.get(index) ?? { buy: false, sell: false };
            if (signal.type === 'buy') {
                row.buy = true;
                row.reasonBuy = signal.reason;
            } else {
                row.sell = true;
                row.reasonSell = signal.reason;
            }
            signalByIndex.set(index, row);
        }

        const signals: Signal[] = [];
        const entryBars: number[] = [];
        let side: 'flat' | 'long' | 'short' = 'flat';
        let entryPrice = 0;
        let trailRef = 0;
        let trailStop = 0;
        let barsHeld = 0;
        let cooldown = 0;

        for (let i = 1; i < cleanData.length; i++) {
            if (cooldown > 0) cooldown--;
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) continue;

            const close = cleanData[i].close;
            const high = cleanData[i].high;
            const low = cleanData[i].low;
            const fib = signalByIndex.get(i);

            if (side !== 'flat') {
                barsHeld += 1;

                if (side === 'long') {
                    trailRef = Math.max(trailRef, high);
                    trailStop = Math.max(trailStop, trailRef - cfg.trailAtr * atrNow);
                    const inProfit = close > entryPrice;
                    const hitStop = close <= trailStop;
                    const staleTrade = barsHeld >= cfg.killIfNoProfitAfterBars && !inProfit;
                    const maxHold = barsHeld >= cfg.maxHoldBars;
                    const oppositeFib = Boolean(fib?.sell);

                    if (hitStop || staleTrade || maxHold || oppositeFib) {
                        const reason = hitStop
                            ? 'Meta v2.2 ATR trail stop long'
                            : staleTrade
                                ? 'Meta v2.2 no-profit timeout long'
                                : maxHold
                                    ? 'Meta v2.2 max-hold long'
                                    : 'Meta v2.2 opposite fib long';
                        signals.push(createSellSignal(cleanData, i, reason));
                        side = 'flat';
                        cooldown = cfg.entryCooldownBars;
                        continue;
                    }
                } else {
                    trailRef = Math.min(trailRef, low);
                    trailStop = Math.min(trailStop, trailRef + cfg.trailAtr * atrNow);
                    const inProfit = close < entryPrice;
                    const hitStop = close >= trailStop;
                    const staleTrade = barsHeld >= cfg.killIfNoProfitAfterBars && !inProfit;
                    const maxHold = barsHeld >= cfg.maxHoldBars;
                    const oppositeFib = Boolean(fib?.buy);

                    if (hitStop || staleTrade || maxHold || oppositeFib) {
                        const reason = hitStop
                            ? 'Meta v2.2 ATR trail stop short'
                            : staleTrade
                                ? 'Meta v2.2 no-profit timeout short'
                                : maxHold
                                    ? 'Meta v2.2 max-hold short'
                                    : 'Meta v2.2 opposite fib short';
                        signals.push(createBuySignal(cleanData, i, reason));
                        side = 'flat';
                        cooldown = cfg.entryCooldownBars;
                        continue;
                    }
                }
            }

            if (side !== 'flat' || cooldown > 0 || !fib) continue;
            if (fib.buy && fib.sell) continue;

            const atrBaseline = atrMa[i];
            const atrExpansion = atrBaseline !== null && atrBaseline > 0 && atrNow > atrBaseline;
            const trendRef = trendSma[i];
            const adxNow = adx[i];
            const strongTrendByAdx = adxNow !== null && adxNow >= cfg.adxTrendThreshold;

            const trendByPriceLong = trendRef !== null && close > trendRef;
            const trendByPriceShort = trendRef !== null && close < trendRef;
            const canBypassLong = trendByPriceLong || strongTrendByAdx;
            const canBypassShort = trendByPriceShort || strongTrendByAdx;

            const cutoff = i - cfg.tradeCapWindowBars + 1;
            while (entryBars.length > 0 && entryBars[0] < cutoff) {
                entryBars.shift();
            }
            if (entryBars.length >= cfg.maxEntriesPerWindow) continue;

            if (fib.buy && cfg.useLong > 0 && (atrExpansion || canBypassLong)) {
                signals.push(createBuySignal(cleanData, i, fib.reasonBuy ?? 'Meta v2.2 fib long'));
                side = 'long';
                entryPrice = close;
                barsHeld = 0;
                trailRef = high;
                trailStop = entryPrice - cfg.initialStopAtr * atrNow;
                entryBars.push(i);
                continue;
            }

            if (fib.sell && cfg.useShort > 0 && (atrExpansion || canBypassShort)) {
                signals.push(createSellSignal(cleanData, i, fib.reasonSell ?? 'Meta v2.2 fib short'));
                side = 'short';
                entryPrice = close;
                barsHeld = 0;
                trailRef = low;
                trailStop = entryPrice + cfg.initialStopAtr * atrNow;
                entryBars.push(i);
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'depth',
            'atrPeriod',
            'deviationMult',
            'levelIndex',
            'entryMode',
            'touchTolerancePct',
            'signalCooldownBars',
            'trailAtr',
            'initialStopAtr',
            'maxHoldBars',
            'killIfNoProfitAfterBars',
            'entryCooldownBars',
            'atrGateMaPeriod',
            'tradeCapWindowBars',
            'maxEntriesPerWindow',
            'trendSmaPeriod',
            'adxPeriod',
            'adxTrendThreshold',
        ],
    },
};
