import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR } from '../indicators';
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
    initialStopAtr: number;
    bankerTriggerProfitPct: number;
    bankerFractionPct: number;
    bankerTrailAtr: number;
    maxHoldBars: number;
    killIfNoProfitAfterBars: number;
    entryCooldownBars: number;
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
        initialStopAtr: clamp(params.initialStopAtr ?? 1.5, 0.2, 12),
        bankerTriggerProfitPct: clamp(params.bankerTriggerProfitPct ?? 3, 0.5, 20),
        bankerFractionPct: clamp(params.bankerFractionPct ?? 50, 5, 95),
        bankerTrailAtr: clamp(params.bankerTrailAtr ?? 2, 0.2, 12),
        maxHoldBars: intClamp(params.maxHoldBars ?? 36, 2, 300),
        killIfNoProfitAfterBars: intClamp(params.killIfNoProfitAfterBars ?? 12, 1, 200),
        entryCooldownBars: intClamp(params.entryCooldownBars ?? 4, 0, 200),
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

export const meta_harvest_v3: Strategy = {
    name: 'Meta Harvest v3',
    description: 'Banker harvest: bank 50% at +3%, move stop to breakeven, and trail remaining size with ATR 2.0.',
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
        initialStopAtr: 1.5,
        bankerTriggerProfitPct: 3,
        bankerFractionPct: 50,
        bankerTrailAtr: 2,
        maxHoldBars: 36,
        killIfNoProfitAfterBars: 12,
        entryCooldownBars: 4,
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
        initialStopAtr: 'Initial Stop ATR',
        bankerTriggerProfitPct: 'Banker Trigger Profit %',
        bankerFractionPct: 'Banker Fraction %',
        bankerTrailAtr: 'Banker Trail ATR',
        maxHoldBars: 'Max Hold Bars',
        killIfNoProfitAfterBars: 'Kill If No Profit After Bars',
        entryCooldownBars: 'Post-Exit Cooldown Bars',
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

        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), cfg.atrPeriod);
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
        let side: 'flat' | 'long' | 'short' = 'flat';
        let entryPrice = 0;
        let stopPrice = 0;
        let trailRef = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let bankedHalf = false;

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
                    const profitPct = ((close - entryPrice) / entryPrice) * 100;
                    if (!bankedHalf && profitPct >= cfg.bankerTriggerProfitPct) {
                        signals.push(createSellSignal(cleanData, i, 'Meta v3 banker partial long', cfg.bankerFractionPct / 100));
                        bankedHalf = true;
                        stopPrice = Math.max(stopPrice, entryPrice);
                        trailRef = high;
                        continue;
                    }

                    if (bankedHalf) {
                        trailRef = Math.max(trailRef, high);
                        stopPrice = Math.max(stopPrice, trailRef - cfg.bankerTrailAtr * atrNow);
                    }

                    const hitStop = close <= stopPrice;
                    const staleTrade = barsHeld >= cfg.killIfNoProfitAfterBars && profitPct <= 0;
                    const maxHold = barsHeld >= cfg.maxHoldBars;
                    const oppositeFib = Boolean(fib?.sell);

                    if (hitStop || staleTrade || maxHold || oppositeFib) {
                        const reason = hitStop
                            ? 'Meta v3 stop/trail long'
                            : staleTrade
                                ? 'Meta v3 no-profit timeout long'
                                : maxHold
                                    ? 'Meta v3 max-hold long'
                                    : 'Meta v3 opposite fib long';
                        signals.push(createSellSignal(cleanData, i, reason));
                        side = 'flat';
                        cooldown = cfg.entryCooldownBars;
                        bankedHalf = false;
                        continue;
                    }
                } else {
                    const profitPct = ((entryPrice - close) / entryPrice) * 100;
                    if (!bankedHalf && profitPct >= cfg.bankerTriggerProfitPct) {
                        signals.push(createBuySignal(cleanData, i, 'Meta v3 banker partial short', cfg.bankerFractionPct / 100));
                        bankedHalf = true;
                        stopPrice = Math.min(stopPrice, entryPrice);
                        trailRef = low;
                        continue;
                    }

                    if (bankedHalf) {
                        trailRef = Math.min(trailRef, low);
                        stopPrice = Math.min(stopPrice, trailRef + cfg.bankerTrailAtr * atrNow);
                    }

                    const hitStop = close >= stopPrice;
                    const staleTrade = barsHeld >= cfg.killIfNoProfitAfterBars && profitPct <= 0;
                    const maxHold = barsHeld >= cfg.maxHoldBars;
                    const oppositeFib = Boolean(fib?.buy);

                    if (hitStop || staleTrade || maxHold || oppositeFib) {
                        const reason = hitStop
                            ? 'Meta v3 stop/trail short'
                            : staleTrade
                                ? 'Meta v3 no-profit timeout short'
                                : maxHold
                                    ? 'Meta v3 max-hold short'
                                    : 'Meta v3 opposite fib short';
                        signals.push(createBuySignal(cleanData, i, reason));
                        side = 'flat';
                        cooldown = cfg.entryCooldownBars;
                        bankedHalf = false;
                        continue;
                    }
                }
            }

            if (side !== 'flat' || cooldown > 0 || !fib) continue;
            if (fib.buy && fib.sell) continue;

            if (fib.buy && cfg.useLong > 0) {
                signals.push(createBuySignal(cleanData, i, fib.reasonBuy ?? 'Meta v3 fib long'));
                side = 'long';
                entryPrice = close;
                barsHeld = 0;
                bankedHalf = false;
                trailRef = high;
                stopPrice = entryPrice - cfg.initialStopAtr * atrNow;
                continue;
            }

            if (fib.sell && cfg.useShort > 0) {
                signals.push(createSellSignal(cleanData, i, fib.reasonSell ?? 'Meta v3 fib short'));
                side = 'short';
                entryPrice = close;
                barsHeld = 0;
                bankedHalf = false;
                trailRef = low;
                stopPrice = entryPrice + cfg.initialStopAtr * atrNow;
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
            'initialStopAtr',
            'bankerTriggerProfitPct',
            'bankerFractionPct',
            'bankerTrailAtr',
            'maxHoldBars',
            'killIfNoProfitAfterBars',
            'entryCooldownBars',
        ],
    },
};
