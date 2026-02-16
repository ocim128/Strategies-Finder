import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateSMA } from "../indicators";
import { buildAdvancedFeatureSet } from "../../signals/feature-engineering";

interface Config {
    fastTrendPeriod: number;
    slowTrendPeriod: number;
    atrPeriod: number;
    volatilitySmaPeriod: number;
    volumeSmaPeriod: number;
    trendEfficiencyLookback: number;
    minVolatilityRatio: number;
    maxVolatilityRatio: number;
    minRelativeVolume: number;
    minTrendEfficiency: number;
    entryConfirmBars: number;
    initialStopAtr: number;
    bankerTriggerProfitPct: number;
    bankerFractionPct: number;
    bankerTrailAtr: number;
    maxHoldBars: number;
    killIfNoProfitAfterBars: number;
    entryCooldownBars: number;
    useLong: number;
    useShort: number;
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
    const minVolatilityRatio = clamp(params.minVolatilityRatio ?? 0.85, 0.2, 5);
    const maxVolatilityRatio = Math.max(minVolatilityRatio + 0.05, clamp(params.maxVolatilityRatio ?? 1.9, 0.3, 8));

    return {
        fastTrendPeriod: intClamp(params.fastTrendPeriod ?? 34, 5, 200),
        slowTrendPeriod: intClamp(params.slowTrendPeriod ?? 144, 20, 600),
        atrPeriod: intClamp(params.atrPeriod ?? 14, 3, 100),
        volatilitySmaPeriod: intClamp(params.volatilitySmaPeriod ?? 64, 10, 400),
        volumeSmaPeriod: intClamp(params.volumeSmaPeriod ?? 34, 5, 240),
        trendEfficiencyLookback: intClamp(params.trendEfficiencyLookback ?? 20, 4, 300),
        minVolatilityRatio,
        maxVolatilityRatio,
        minRelativeVolume: clamp(params.minRelativeVolume ?? 1.05, 0.2, 10),
        minTrendEfficiency: clamp(params.minTrendEfficiency ?? 0.24, 0, 1),
        entryConfirmBars: intClamp(params.entryConfirmBars ?? 2, 1, 50),
        initialStopAtr: clamp(params.initialStopAtr ?? 1.4, 0.2, 12),
        bankerTriggerProfitPct: clamp(params.bankerTriggerProfitPct ?? 2.5, 0.2, 30),
        bankerFractionPct: clamp(params.bankerFractionPct ?? 50, 5, 95),
        bankerTrailAtr: clamp(params.bankerTrailAtr ?? 1.8, 0.2, 12),
        maxHoldBars: intClamp(params.maxHoldBars ?? 48, 2, 400),
        killIfNoProfitAfterBars: intClamp(params.killIfNoProfitAfterBars ?? 12, 1, 300),
        entryCooldownBars: intClamp(params.entryCooldownBars ?? 4, 0, 300),
        useLong: intClamp(params.useLong ?? 1, 0, 1),
        useShort: intClamp(params.useShort ?? 1, 0, 1),
    };
}

export const meta_harvest_v3: Strategy = {
    name: "Meta Harvest v3",
    description: "Feature-engineered non-repainting regime strategy using volatility ratio, relative volume, and trend efficiency.",
    defaultParams: {
        fastTrendPeriod: 34,
        slowTrendPeriod: 144,
        atrPeriod: 14,
        volatilitySmaPeriod: 64,
        volumeSmaPeriod: 34,
        trendEfficiencyLookback: 20,
        minVolatilityRatio: 0.85,
        maxVolatilityRatio: 1.9,
        minRelativeVolume: 1.05,
        minTrendEfficiency: 0.24,
        entryConfirmBars: 2,
        initialStopAtr: 1.4,
        bankerTriggerProfitPct: 2.5,
        bankerFractionPct: 50,
        bankerTrailAtr: 1.8,
        maxHoldBars: 48,
        killIfNoProfitAfterBars: 12,
        entryCooldownBars: 4,
        useLong: 1,
        useShort: 1,
    },
    paramLabels: {
        fastTrendPeriod: "Fast Trend SMA",
        slowTrendPeriod: "Slow Trend SMA",
        atrPeriod: "ATR Period",
        volatilitySmaPeriod: "ATR SMA Period",
        volumeSmaPeriod: "Volume SMA Period",
        trendEfficiencyLookback: "Trend Efficiency Lookback",
        minVolatilityRatio: "Min Volatility Ratio",
        maxVolatilityRatio: "Max Volatility Ratio",
        minRelativeVolume: "Min Relative Volume",
        minTrendEfficiency: "Min Trend Efficiency",
        entryConfirmBars: "Entry Confirm Bars",
        initialStopAtr: "Initial Stop ATR",
        bankerTriggerProfitPct: "Banker Trigger Profit %",
        bankerFractionPct: "Banker Fraction %",
        bankerTrailAtr: "Banker Trail ATR",
        maxHoldBars: "Max Hold Bars",
        killIfNoProfitAfterBars: "Kill If No Profit After Bars",
        entryCooldownBars: "Post-Exit Cooldown Bars",
        useLong: "Enable Long (0/1)",
        useShort: "Enable Short (0/1)",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const cfg = normalize(params);
        const minBars = Math.max(
            cfg.slowTrendPeriod + 2,
            cfg.atrPeriod + cfg.volatilitySmaPeriod + 2,
            cfg.volumeSmaPeriod + 2,
            cfg.trendEfficiencyLookback + 2
        );
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const fastTrend = calculateSMA(closes, cfg.fastTrendPeriod);
        const slowTrend = calculateSMA(closes, cfg.slowTrendPeriod);
        const features = buildAdvancedFeatureSet(cleanData, {
            atrPeriod: cfg.atrPeriod,
            volatilitySmaPeriod: cfg.volatilitySmaPeriod,
            volumeSmaPeriod: cfg.volumeSmaPeriod,
            trendEfficiencyLookback: cfg.trendEfficiencyLookback,
        });

        const signals: Signal[] = [];
        let side: "flat" | "long" | "short" = "flat";
        let entryPrice = 0;
        let stopPrice = 0;
        let trailRef = 0;
        let barsHeld = 0;
        let cooldown = 0;
        let bankedHalf = false;
        let longConfirm = 0;
        let shortConfirm = 0;

        for (let i = 1; i < cleanData.length; i++) {
            const close = cleanData[i].close;
            const high = cleanData[i].high;
            const low = cleanData[i].low;
            const atrNow = features.atr[i];
            const volRatio = features.volatilityRatio[i];
            const relVolume = features.relativeVolume[i];
            const efficiency = features.trendEfficiency[i];
            const fastNow = fastTrend[i];
            const slowNow = slowTrend[i];

            if (
                atrNow === null ||
                volRatio === null ||
                relVolume === null ||
                efficiency === null ||
                fastNow === null ||
                slowNow === null
            ) {
                continue;
            }

            const trendUp = fastNow > slowNow && close > fastNow;
            const trendDown = fastNow < slowNow && close < fastNow;
            const efficiencyStrength = Math.abs(efficiency);
            const regimePass =
                volRatio >= cfg.minVolatilityRatio &&
                volRatio <= cfg.maxVolatilityRatio &&
                relVolume >= cfg.minRelativeVolume &&
                efficiencyStrength >= cfg.minTrendEfficiency;
            const longSetup = cfg.useLong > 0 && regimePass && trendUp && efficiency > 0;
            const shortSetup = cfg.useShort > 0 && regimePass && trendDown && efficiency < 0;

            if (side !== "flat") {
                barsHeld += 1;

                if (side === "long") {
                    const profitPct = ((close - entryPrice) / entryPrice) * 100;
                    if (!bankedHalf && profitPct >= cfg.bankerTriggerProfitPct) {
                        signals.push(createSellSignal(cleanData, i, "Meta v3 banker partial long", cfg.bankerFractionPct / 100));
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
                    const regimeExit = !longSetup || trendDown;
                    if (hitStop || staleTrade || maxHold || regimeExit) {
                        const reason = hitStop
                            ? "Meta v3 stop/trail long"
                            : staleTrade
                                ? "Meta v3 no-profit timeout long"
                                : maxHold
                                    ? "Meta v3 max-hold long"
                                    : "Meta v3 regime exit long";
                        signals.push(createSellSignal(cleanData, i, reason));
                        side = "flat";
                        barsHeld = 0;
                        bankedHalf = false;
                        cooldown = cfg.entryCooldownBars;
                        longConfirm = 0;
                        shortConfirm = 0;
                        continue;
                    }
                } else {
                    const profitPct = ((entryPrice - close) / entryPrice) * 100;
                    if (!bankedHalf && profitPct >= cfg.bankerTriggerProfitPct) {
                        signals.push(createBuySignal(cleanData, i, "Meta v3 banker partial short", cfg.bankerFractionPct / 100));
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
                    const regimeExit = !shortSetup || trendUp;
                    if (hitStop || staleTrade || maxHold || regimeExit) {
                        const reason = hitStop
                            ? "Meta v3 stop/trail short"
                            : staleTrade
                                ? "Meta v3 no-profit timeout short"
                                : maxHold
                                    ? "Meta v3 max-hold short"
                                    : "Meta v3 regime exit short";
                        signals.push(createBuySignal(cleanData, i, reason));
                        side = "flat";
                        barsHeld = 0;
                        bankedHalf = false;
                        cooldown = cfg.entryCooldownBars;
                        longConfirm = 0;
                        shortConfirm = 0;
                        continue;
                    }
                }
            }

            if (side !== "flat") continue;
            if (cooldown > 0) {
                cooldown -= 1;
                longConfirm = 0;
                shortConfirm = 0;
                continue;
            }

            longConfirm = longSetup ? longConfirm + 1 : 0;
            shortConfirm = shortSetup ? shortConfirm + 1 : 0;

            if (longConfirm >= cfg.entryConfirmBars && shortConfirm === 0) {
                signals.push(createBuySignal(cleanData, i, "Meta v3 feature long"));
                side = "long";
                entryPrice = close;
                stopPrice = entryPrice - cfg.initialStopAtr * atrNow;
                trailRef = high;
                barsHeld = 0;
                bankedHalf = false;
                longConfirm = 0;
                shortConfirm = 0;
                continue;
            }

            if (shortConfirm >= cfg.entryConfirmBars && longConfirm === 0) {
                signals.push(createSellSignal(cleanData, i, "Meta v3 feature short"));
                side = "short";
                entryPrice = close;
                stopPrice = entryPrice + cfg.initialStopAtr * atrNow;
                trailRef = low;
                barsHeld = 0;
                bankedHalf = false;
                longConfirm = 0;
                shortConfirm = 0;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: [
            "fastTrendPeriod",
            "slowTrendPeriod",
            "atrPeriod",
            "volatilitySmaPeriod",
            "volumeSmaPeriod",
            "trendEfficiencyLookback",
            "minVolatilityRatio",
            "maxVolatilityRatio",
            "minRelativeVolume",
            "minTrendEfficiency",
            "entryConfirmBars",
            "initialStopAtr",
            "bankerTriggerProfitPct",
            "bankerFractionPct",
            "bankerTrailAtr",
            "maxHoldBars",
            "killIfNoProfitAfterBars",
            "entryCooldownBars",
        ],
    },
};

