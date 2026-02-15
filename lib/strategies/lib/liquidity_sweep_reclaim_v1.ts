import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR } from "../indicators";

interface SweepConfig {
    atrPeriod: number;
    sweepBufferAtr: number;
    stopBufferAtr: number;
    reclaimMinAtr: number;
    maxHoldBars: number;
    cooldownBars: number;
    maxTradesPerDay: number;
}

interface DailyLevels {
    pdh: number;
    pdl: number;
    mid: number;
    dayKey: number;
}

function toUnixSeconds(value: OHLCVData["time"]): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    if (typeof value === "object" && value !== null && "year" in value && "month" in value && "day" in value) {
        const v = value as { year: number; month: number; day: number };
        return Math.floor(Date.UTC(v.year, v.month - 1, v.day) / 1000);
    }
    return null;
}

function buildPreviousDayLevels(data: OHLCVData[]): Array<DailyLevels | null> {
    const dayStats = new Map<number, { high: number; low: number }>();
    const dayByBar: Array<number | null> = new Array(data.length).fill(null);

    for (let i = 0; i < data.length; i++) {
        const ts = toUnixSeconds(data[i].time);
        if (ts === null) continue;
        const dayKey = Math.floor(ts / 86_400);
        dayByBar[i] = dayKey;
        const existing = dayStats.get(dayKey);
        if (!existing) {
            dayStats.set(dayKey, { high: data[i].high, low: data[i].low });
        } else {
            existing.high = Math.max(existing.high, data[i].high);
            existing.low = Math.min(existing.low, data[i].low);
        }
    }

    const levels: Array<DailyLevels | null> = new Array(data.length).fill(null);
    for (let i = 0; i < data.length; i++) {
        const dayKey = dayByBar[i];
        if (dayKey === null) continue;
        const prev = dayStats.get(dayKey - 1);
        if (!prev) continue;
        levels[i] = {
            pdh: prev.high,
            pdl: prev.low,
            mid: (prev.high + prev.low) / 2,
            dayKey,
        };
    }
    return levels;
}

function normalizeConfig(params: StrategyParams): SweepConfig {
    return {
        atrPeriod: Math.max(3, Math.round(params.atrPeriod ?? 14)),
        sweepBufferAtr: Math.max(0, params.sweepBufferAtr ?? 0.05),
        stopBufferAtr: Math.max(0, params.stopBufferAtr ?? 0.1),
        reclaimMinAtr: Math.max(0, params.reclaimMinAtr ?? 0),
        maxHoldBars: Math.max(1, Math.round(params.maxHoldBars ?? 12)),
        cooldownBars: Math.max(0, Math.round(params.cooldownBars ?? 2)),
        maxTradesPerDay: Math.max(1, Math.round(params.maxTradesPerDay ?? 3)),
    };
}

export const liquidity_sweep_reclaim_v1: Strategy = {
    name: "Liquidity Sweep Reclaim v1",
    description: "Strict Turtle Soup mean-reversion scalp using PDH/PDL sweep-and-reclaim with wick stop and prior-day mid-range target.",
    defaultParams: {
        atrPeriod: 14,
        sweepBufferAtr: 0.05,
        stopBufferAtr: 0.1,
        reclaimMinAtr: 0,
        maxHoldBars: 12,
        cooldownBars: 2,
        maxTradesPerDay: 3,
    },
    paramLabels: {
        atrPeriod: "ATR Period",
        sweepBufferAtr: "Sweep Buffer (ATR)",
        stopBufferAtr: "Stop Buffer (ATR)",
        reclaimMinAtr: "Reclaim Distance (ATR)",
        maxHoldBars: "Max Hold Bars",
        cooldownBars: "Cooldown Bars",
        maxTradesPerDay: "Max Trades Per Day",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];

        const cfg = normalizeConfig(params);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, cfg.atrPeriod);
        const levels = buildPreviousDayLevels(cleanData);

        const signals: Signal[] = [];
        let cooldown = 0;
        let dayTrades = new Map<number, number>();

        let inPosition = false;
        let side: "long" | "short" | null = null;
        let holdBars = 0;
        let stop = 0;
        let target = 0;
        let activeDayKey = -1;

        for (let i = 1; i < cleanData.length; i++) {
            const level = levels[i];
            const atrNow = atr[i];
            if (!level || atrNow === null) continue;

            // Reset per-day trade cap map gradually as days advance to keep map tiny.
            if (activeDayKey !== level.dayKey) {
                activeDayKey = level.dayKey;
                if (dayTrades.size > 10) {
                    const keep = new Map<number, number>();
                    for (let d = level.dayKey - 5; d <= level.dayKey; d++) {
                        const c = dayTrades.get(d);
                        if (c !== undefined) keep.set(d, c);
                    }
                    dayTrades = keep;
                }
            }

            if (inPosition && side) {
                holdBars++;

                if (side === "long") {
                    const hitStop = lows[i] <= stop;
                    const hitTarget = highs[i] >= target;
                    const timeout = holdBars >= cfg.maxHoldBars;
                    if (hitStop || hitTarget || timeout) {
                        const reason = hitStop
                            ? "Sweep reclaim long stop"
                            : hitTarget
                                ? "Sweep reclaim long target(mid)"
                                : "Sweep reclaim long timeout";
                        signals.push(createSellSignal(cleanData, i, reason));
                        inPosition = false;
                        side = null;
                        holdBars = 0;
                        cooldown = cfg.cooldownBars;
                    }
                } else {
                    const hitStop = highs[i] >= stop;
                    const hitTarget = lows[i] <= target;
                    const timeout = holdBars >= cfg.maxHoldBars;
                    if (hitStop || hitTarget || timeout) {
                        const reason = hitStop
                            ? "Sweep reclaim short stop"
                            : hitTarget
                                ? "Sweep reclaim short target(mid)"
                                : "Sweep reclaim short timeout";
                        signals.push(createBuySignal(cleanData, i, reason));
                        inPosition = false;
                        side = null;
                        holdBars = 0;
                        cooldown = cfg.cooldownBars;
                    }
                }
                continue;
            }

            if (cooldown > 0) {
                cooldown--;
                continue;
            }

            const tradesToday = dayTrades.get(level.dayKey) ?? 0;
            if (tradesToday >= cfg.maxTradesPerDay) continue;

            const sweepBuffer = cfg.sweepBufferAtr * atrNow;
            const reclaimMin = cfg.reclaimMinAtr * atrNow;

            // Long Turtle Soup: sweep below PDL, then close back above PDL.
            const sweptPdl = lows[i] < level.pdl - sweepBuffer;
            const reclaimedPdl = closes[i] >= level.pdl + reclaimMin && closes[i] <= level.pdh;
            if (sweptPdl && reclaimedPdl && level.mid > closes[i]) {
                inPosition = true;
                side = "long";
                holdBars = 0;
                stop = lows[i] - cfg.stopBufferAtr * atrNow;
                target = level.mid;
                dayTrades.set(level.dayKey, tradesToday + 1);
                signals.push(createBuySignal(cleanData, i, "Turtle Soup long reclaim(PDL)"));
                continue;
            }

            // Short Turtle Soup: sweep above PDH, then close back below PDH.
            const sweptPdh = highs[i] > level.pdh + sweepBuffer;
            const reclaimedPdh = closes[i] <= level.pdh - reclaimMin && closes[i] >= level.pdl;
            if (sweptPdh && reclaimedPdh && level.mid < closes[i]) {
                inPosition = true;
                side = "short";
                holdBars = 0;
                stop = highs[i] + cfg.stopBufferAtr * atrNow;
                target = level.mid;
                dayTrades.set(level.dayKey, tradesToday + 1);
                signals.push(createSellSignal(cleanData, i, "Turtle Soup short reclaim(PDH)"));
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: [
            "sweepBufferAtr",
            "stopBufferAtr",
            "reclaimMinAtr",
            "maxHoldBars",
            "cooldownBars",
            "maxTradesPerDay",
        ],
    },
};
