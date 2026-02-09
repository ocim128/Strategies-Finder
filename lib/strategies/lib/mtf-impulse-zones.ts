import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator, Time } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';
import { resampleOHLCV } from '../resample-utils';
import { COLORS } from '../constants';

type ZoneType = 'supply' | 'demand';

interface Zone {
    id: number;
    type: ZoneType;
    top: number;
    bottom: number;
    createdTime: number;
    createdIndex: number | null;
    active: boolean;
    retests: number;
    lastTouchIndex: number;
    tfLabel: string;
}

interface ZoneState {
    zones: Zone[];
    demandTop: (number | null)[];
    demandBottom: (number | null)[];
    supplyTop: (number | null)[];
    supplyBottom: (number | null)[];
}

function toNumber(time: Time, fallback: number): number {
    if (typeof time === 'number') return time;
    if (typeof time === 'string') {
        const parsed = Date.parse(time);
        return Number.isNaN(parsed) ? fallback : Math.floor(parsed / 1000);
    }
    if (time && typeof time === 'object' && 'year' in time) {
        const t = time as { year: number; month: number; day: number };
        return Math.floor(Date.UTC(t.year, t.month - 1, t.day) / 1000);
    }
    return fallback;
}

function normalizeMinutes(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}

function normalizeTfLabel(minutes: number): string {
    return `${minutes}m`;
}

function getBaseTimes(data: OHLCVData[]): number[] {
    return data.map((bar, i) => toNumber(bar.time, i));
}

function computeImpulseZones(
    data: OHLCVData[],
    tfMinutes: number,
    tfLabel: string,
    impulseAtrMult: number,
    maxDistAtrMult: number,
    maxZonesPerSide: number
): Zone[] {
    if (data.length === 0) return [];

    const hasNumericTime = typeof data[0].time === 'number';
    const htfData = hasNumericTime ? resampleOHLCV(data, normalizeTfLabel(tfMinutes)) : data;

    const highs = getHighs(htfData);
    const lows = getLows(htfData);
    const closes = getCloses(htfData);
    const atr = calculateATR(highs, lows, closes, 14);

    let lastBearLow: number | null = null;
    let lastBearHigh: number | null = null;
    let lastBullLow: number | null = null;
    let lastBullHigh: number | null = null;

    const demandZones: Zone[] = [];
    const supplyZones: Zone[] = [];

    for (let i = 1; i < htfData.length; i++) {
        const prev = htfData[i - 1];
        const atrPrev = atr[i - 1];
        const prevBody = Math.abs(prev.close - prev.open);

        if (prev.close < prev.open) {
            lastBearLow = prev.low;
            lastBearHigh = prev.high;
        } else if (prev.close > prev.open) {
            lastBullLow = prev.low;
            lastBullHigh = prev.high;
        }

        if (atrPrev === null || atrPrev <= 0) continue;

        const bullImpulse = prev.close > prev.open && prevBody >= impulseAtrMult * atrPrev;
        const bearImpulse = prev.close < prev.open && prevBody >= impulseAtrMult * atrPrev;

        if (bullImpulse && lastBearLow !== null && lastBearHigh !== null) {
            const dist = Math.abs(prev.close - lastBearLow);
            if (dist <= atrPrev * maxDistAtrMult) {
                demandZones.push({
                    id: i * 2 + demandZones.length,
                    type: 'demand',
                    top: lastBearHigh,
                    bottom: lastBearLow,
                    createdTime: toNumber(htfData[i].time, i),
                    createdIndex: null,
                    active: false,
                    retests: 0,
                    lastTouchIndex: -1,
                    tfLabel,
                });
                if (demandZones.length > maxZonesPerSide) demandZones.shift();
            }
        }

        if (bearImpulse && lastBullLow !== null && lastBullHigh !== null) {
            const dist = Math.abs(prev.close - lastBullHigh);
            if (dist <= atrPrev * maxDistAtrMult) {
                supplyZones.push({
                    id: i * 2 + supplyZones.length,
                    type: 'supply',
                    top: lastBullHigh,
                    bottom: lastBullLow,
                    createdTime: toNumber(htfData[i].time, i),
                    createdIndex: null,
                    active: false,
                    retests: 0,
                    lastTouchIndex: -1,
                    tfLabel,
                });
                if (supplyZones.length > maxZonesPerSide) supplyZones.shift();
            }
        }
    }

    return [...demandZones, ...supplyZones];
}

function applyZoneLifecycle(
    zones: Zone[],
    bar: OHLCVData,
    index: number,
    timeValue: number,
    mitigationPct: number,
    maxZoneAge: number,
    retestCooldown: number
): void {
    for (const zone of zones) {
        if (!zone.active && timeValue >= zone.createdTime) {
            zone.active = true;
            zone.createdIndex = index;
            zone.lastTouchIndex = index;
        }

        if (!zone.active || zone.createdIndex === null) continue;

        if (maxZoneAge > 0 && index - zone.createdIndex > maxZoneAge) {
            zone.active = false;
            continue;
        }

        const touched = bar.high >= zone.bottom && bar.low <= zone.top;
        if (touched && index - zone.lastTouchIndex >= retestCooldown && index > zone.createdIndex) {
            zone.retests += 1;
            zone.lastTouchIndex = index;
        }

        if (mitigationPct > 0) {
            const mid = zone.bottom + (zone.top - zone.bottom) * mitigationPct;
            if (zone.type === 'demand' && bar.low <= mid) {
                zone.active = false;
            } else if (zone.type === 'supply' && bar.high >= mid) {
                zone.active = false;
            }
        }
    }
}

function findNearestZones(
    zones: Zone[],
    close: number
): { demand: Zone | null; supply: Zone | null } {
    let bestDemand: Zone | null = null;
    let bestSupply: Zone | null = null;
    let bestDemandDist = Infinity;
    let bestSupplyDist = Infinity;

    for (const zone of zones) {
        if (!zone.active) continue;
        const dist = close < zone.bottom
            ? zone.bottom - close
            : close > zone.top
                ? close - zone.top
                : 0;

        if (zone.type === 'demand' && dist < bestDemandDist) {
            bestDemandDist = dist;
            bestDemand = zone;
        } else if (zone.type === 'supply' && dist < bestSupplyDist) {
            bestSupplyDist = dist;
            bestSupply = zone;
        }
    }

    return { demand: bestDemand, supply: bestSupply };
}

function distanceToZone(bar: OHLCVData, zone: Zone): number {
    if (bar.high < zone.bottom) return zone.bottom - bar.high;
    if (bar.low > zone.top) return bar.low - zone.top;
    return 0;
}

function buildZones(data: OHLCVData[], params: StrategyParams): Zone[] {
    const cleanData = ensureCleanData(data);
    const useTF1 = (params.useTF1 ?? 1) >= 1;
    const useTF2 = (params.useTF2 ?? 1) >= 1;
    const useTF3 = (params.useTF3 ?? 0) >= 1;

    const tf1Minutes = normalizeMinutes(params.tf1Minutes, 240);
    const tf2Minutes = normalizeMinutes(params.tf2Minutes, 60);
    const tf3Minutes = normalizeMinutes(params.tf3Minutes, 15);

    const maxZonesPerSide = Math.max(1, Math.floor(params.maxZonesPerSide ?? 6));
    const impulseAtrMult = Math.max(0.1, params.impulseAtrMult ?? 0.8);
    const maxDistAtrMult = Math.max(0.5, params.maxDistAtrMult ?? 5.0);

    const zones: Zone[] = [];
    if (useTF1) {
        zones.push(...computeImpulseZones(cleanData, tf1Minutes, `TF1-${tf1Minutes}m`, impulseAtrMult, maxDistAtrMult, maxZonesPerSide));
    }
    if (useTF2) {
        zones.push(...computeImpulseZones(cleanData, tf2Minutes, `TF2-${tf2Minutes}m`, impulseAtrMult, maxDistAtrMult, maxZonesPerSide));
    }
    if (useTF3) {
        zones.push(...computeImpulseZones(cleanData, tf3Minutes, `TF3-${tf3Minutes}m`, impulseAtrMult, maxDistAtrMult, maxZonesPerSide));
    }

    return zones;
}

function cloneZones(zones: Zone[]): Zone[] {
    return zones.map(zone => ({ ...zone }));
}

function computeZoneState(
    data: OHLCVData[],
    params: StrategyParams
): ZoneState {
    const cleanData = ensureCleanData(data);
    const baseTimes = getBaseTimes(cleanData);
    const mitigationPct = Math.max(0, Math.min(1, params.mitigationPct ?? 0.5));
    const maxZoneAge = Math.max(0, Math.floor(params.maxZoneAge ?? 600));
    const retestCooldown = Math.max(1, Math.floor(params.retestCooldown ?? 3));

    const zones = cloneZones(buildZones(cleanData, params));

    const demandTop: (number | null)[] = new Array(cleanData.length).fill(null);
    const demandBottom: (number | null)[] = new Array(cleanData.length).fill(null);
    const supplyTop: (number | null)[] = new Array(cleanData.length).fill(null);
    const supplyBottom: (number | null)[] = new Array(cleanData.length).fill(null);

    for (let i = 0; i < cleanData.length; i++) {
        applyZoneLifecycle(zones, cleanData[i], i, baseTimes[i], mitigationPct, maxZoneAge, retestCooldown);

        const nearest = findNearestZones(zones, cleanData[i].close);
        demandTop[i] = nearest.demand ? nearest.demand.top : null;
        demandBottom[i] = nearest.demand ? nearest.demand.bottom : null;
        supplyTop[i] = nearest.supply ? nearest.supply.top : null;
        supplyBottom[i] = nearest.supply ? nearest.supply.bottom : null;
    }

    return { zones, demandTop, demandBottom, supplyTop, supplyBottom };
}

export const mtf_impulse_zone_reversal: Strategy = {
    name: 'MTF Impulse Zones (Reversal)',
    description: 'Impulse-created MTF supply/demand zones with proximity + rejection entries (simplified params)',
    defaultParams: {
        tf1Minutes: 240,
        tf2Minutes: 60,
        impulseAtrMult: 0.8,
        maxDistAtrMult: 5.0,
        proximityPercent: 0.15,
        minConfluence: 1,
    },
    paramLabels: {
        tf1Minutes: 'TF1 Minutes',
        tf2Minutes: 'TF2 Minutes',
        impulseAtrMult: 'Impulse Body >= ATR *',
        maxDistAtrMult: 'Max Dist from Impulse (ATR * )',
        proximityPercent: 'Proximity (%)',
        minConfluence: 'Min TF Confluence (1-3)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const zones = cloneZones(buildZones(cleanData, params));
        const baseTimes = getBaseTimes(cleanData);
        const proximityPercent = Math.max(0.01, params.proximityPercent ?? 0.15);
        const minConfluence = Math.max(1, Math.min(3, Math.floor(params.minConfluence ?? 1)));
        const requireRejection = (params.requireRejection ?? 1) >= 1;
        const trendEmaPeriod = Math.max(0, Math.floor(params.trendEmaPeriod ?? 0));
        const mitigationPct = Math.max(0, Math.min(1, params.mitigationPct ?? 0.5));
        const maxZoneAge = Math.max(0, Math.floor(params.maxZoneAge ?? 600));
        const retestCooldown = Math.max(1, Math.floor(params.retestCooldown ?? 3));

        const closes = getCloses(cleanData);
        const ema = trendEmaPeriod > 0 ? calculateEMA(closes, trendEmaPeriod) : [];

        const signals: Signal[] = [];

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const proxRange = bar.close * proximityPercent / 100;
            const timeValue = baseTimes[i];

            applyZoneLifecycle(zones, bar, i, timeValue, mitigationPct, maxZoneAge, retestCooldown);

            let demandConfluence = 0;
            let supplyConfluence = 0;
            let bestDemand: Zone | null = null;
            let bestSupply: Zone | null = null;
            let bestDemandDist = Infinity;
            let bestSupplyDist = Infinity;

            const demandTfs = new Set<string>();
            const supplyTfs = new Set<string>();

            for (const zone of zones) {
                if (!zone.active || zone.createdIndex === null) continue;
                if (timeValue < zone.createdTime) continue;

                const dist = distanceToZone(bar, zone);
                if (dist > proxRange) continue;

                if (zone.type === 'demand') {
                    demandTfs.add(zone.tfLabel);
                    if (dist < bestDemandDist) {
                        bestDemandDist = dist;
                        bestDemand = zone;
                    }
                } else {
                    supplyTfs.add(zone.tfLabel);
                    if (dist < bestSupplyDist) {
                        bestSupplyDist = dist;
                        bestSupply = zone;
                    }
                }
            }

            demandConfluence = demandTfs.size;
            supplyConfluence = supplyTfs.size;

            if (bestDemand && demandConfluence >= minConfluence) {
                const rejectionOk = !requireRejection || bar.close > bar.open;
                const trendOk = trendEmaPeriod <= 0 || (ema[i] !== null && bar.close >= (ema[i] as number));
                if (rejectionOk && trendOk) {
                    const reason = demandConfluence > 1
                        ? `MTF Demand Reversal (${demandConfluence} TFs)`
                        : 'MTF Demand Reversal';
                    signals.push(createBuySignal(cleanData, i, reason));
                }
            }

            if (bestSupply && supplyConfluence >= minConfluence) {
                const rejectionOk = !requireRejection || bar.close < bar.open;
                const trendOk = trendEmaPeriod <= 0 || (ema[i] !== null && bar.close <= (ema[i] as number));
                if (rejectionOk && trendOk) {
                    const reason = supplyConfluence > 1
                        ? `MTF Supply Reversal (${supplyConfluence} TFs)`
                        : 'MTF Supply Reversal';
                    signals.push(createSellSignal(cleanData, i, reason));
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const state = computeZoneState(cleanData, params);

        return [
            { name: 'MTF Demand Top', type: 'line', values: state.demandTop, color: COLORS.Positive },
            { name: 'MTF Demand Bottom', type: 'line', values: state.demandBottom, color: COLORS.Positive },
            { name: 'MTF Supply Top', type: 'line', values: state.supplyTop, color: COLORS.Trend },
            { name: 'MTF Supply Bottom', type: 'line', values: state.supplyBottom, color: COLORS.Trend },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};

export const mtf_impulse_zone_breakout: Strategy = {
    name: 'MTF Impulse Zones (Breakout)',
    description: 'Tracks MTF impulse zones and trades breakouts after retests (simplified params)',
    defaultParams: {
        tf1Minutes: 240,
        tf2Minutes: 60,
        impulseAtrMult: 0.8,
        maxDistAtrMult: 5.0,
        minRetests: 2,
        breakoutAtrMult: 0.4,
    },
    paramLabels: {
        tf1Minutes: 'TF1 Minutes',
        tf2Minutes: 'TF2 Minutes',
        impulseAtrMult: 'Impulse Body >= ATR *',
        maxDistAtrMult: 'Max Dist from Impulse (ATR * )',
        minRetests: 'Min Retests before Breakout',
        breakoutAtrMult: 'Breakout Buffer (ATR *)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const zones = cloneZones(buildZones(cleanData, params));
        const baseTimes = getBaseTimes(cleanData);
        const atrPeriod = Math.max(2, Math.floor(params.atrPeriod ?? 14));
        const minRetests = Math.max(0, Math.floor(params.minRetests ?? 2));
        const breakoutAtrMult = Math.max(0, params.breakoutAtrMult ?? 0.4);
        const mitigationPct = Math.max(0, Math.min(1, params.mitigationPct ?? 0.5));
        const maxZoneAge = Math.max(0, Math.floor(params.maxZoneAge ?? 800));
        const retestCooldown = Math.max(1, Math.floor(params.retestCooldown ?? 3));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const signals: Signal[] = [];

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) continue;

            const buffer = atrNow * breakoutAtrMult;
            const timeValue = baseTimes[i];

            applyZoneLifecycle(zones, bar, i, timeValue, mitigationPct, maxZoneAge, retestCooldown);

            for (const zone of zones) {
                if (!zone.active || zone.createdIndex === null) continue;
                if (timeValue < zone.createdTime) continue;
                if (zone.retests < minRetests) continue;

                if (zone.type === 'supply') {
                    if (bar.close > zone.top + buffer) {
                        signals.push(createBuySignal(cleanData, i, `Supply Breakout (${zone.tfLabel})`));
                        zone.active = false;
                    }
                } else if (zone.type === 'demand') {
                    if (bar.close < zone.bottom - buffer) {
                        signals.push(createSellSignal(cleanData, i, `Demand Breakdown (${zone.tfLabel})`));
                        zone.active = false;
                    }
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const state = computeZoneState(cleanData, params);
        const atrPeriod = Math.max(2, Math.floor(params.atrPeriod ?? 14));
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        return [
            { name: 'MTF Demand Top', type: 'line', values: state.demandTop, color: COLORS.Positive },
            { name: 'MTF Demand Bottom', type: 'line', values: state.demandBottom, color: COLORS.Positive },
            { name: 'MTF Supply Top', type: 'line', values: state.supplyTop, color: COLORS.Trend },
            { name: 'MTF Supply Bottom', type: 'line', values: state.supplyBottom, color: COLORS.Trend },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Neutral },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};


