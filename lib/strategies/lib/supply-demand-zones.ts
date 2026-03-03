import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../../types/strategies';
import { buildPivotFlags, createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR } from '../indicators';
import { COLORS } from '../constants';

interface Zone {
    id: number;
    type: 'supply' | 'demand';
    top: number;
    bottom: number;
    pivotIndex: number;
    createdIndex: number;
    retests: number;
    lastRetestIndex: number;
    active: boolean;
}

interface ZoneCandidates {
    supply: Zone[];
    demand: Zone[];
}

const RETEST_COOLDOWN = 3;
const INTERNAL_ATR_PERIOD = 14;
const INTERNAL_MAX_ZONES = 10;
const INTERNAL_MIN_ZONE_DISTANCE_MULTIPLIER = 2;
const INTERNAL_INVALIDATION_MODE = 0; // 0 = close-based invalidation
const INTERNAL_MAX_ZONE_AGE = 1000;
const INTERNAL_STRENGTH_DECAY_BARS = 200;
const INTERNAL_RETEST_PENALTY = 1.5;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function computeStrength(zone: Zone, index: number, decayBars: number, retestPenalty: number): number {
    if (decayBars <= 0) return 10;
    const age = Math.max(0, index - zone.createdIndex);
    const agePenalty = (age / decayBars) * 5;
    const retestPenaltyTotal = zone.retests * retestPenalty;
    return clamp(10 - agePenalty - retestPenaltyTotal, 1, 10);
}

function createSupplyZone(
    data: OHLCVData[],
    pivotIndex: number,
    createdIndex: number,
    atrValue: number,
    zoneWidthAtr: number
): Zone | null {
    const bar = data[pivotIndex];
    const top = bar.high;
    const height = atrValue * zoneWidthAtr;
    if (height <= 0) return null;
    const bottom = top - height;

    return {
        id: pivotIndex,
        type: 'supply',
        top,
        bottom,
        pivotIndex,
        createdIndex,
        retests: 0,
        lastRetestIndex: createdIndex,
        active: true,
    };
}

function createDemandZone(
    data: OHLCVData[],
    pivotIndex: number,
    createdIndex: number,
    atrValue: number,
    zoneWidthAtr: number
): Zone | null {
    const bar = data[pivotIndex];
    const bottom = bar.low;
    const height = atrValue * zoneWidthAtr;
    if (height <= 0) return null;
    const top = bottom + height;

    return {
        id: pivotIndex,
        type: 'demand',
        top,
        bottom,
        pivotIndex,
        createdIndex,
        retests: 0,
        lastRetestIndex: createdIndex,
        active: true,
    };
}

function updateZoneState(
    zone: Zone,
    bar: OHLCVData,
    index: number,
    invalidationMode: number,
    maxAge: number
): void {
    if (!zone.active) return;

    if (maxAge > 0 && index - zone.createdIndex > maxAge) {
        zone.active = false;
        return;
    }

    const broken = invalidationMode === 1
        ? (zone.type === 'supply' ? bar.high > zone.top : bar.low < zone.bottom)
        : (zone.type === 'supply' ? bar.close > zone.top : bar.close < zone.bottom);

    if (broken) {
        zone.active = false;
        return;
    }

    const touched = bar.high >= zone.bottom && bar.low <= zone.top;
    if (touched && index > zone.createdIndex && index - zone.lastRetestIndex > RETEST_COOLDOWN) {
        zone.retests += 1;
        zone.lastRetestIndex = index;
    }
}

function selectStrongestZone(zones: Zone[], index: number, decayBars: number, retestPenalty: number): Zone | null {
    let best: Zone | null = null;
    let bestStrength = -Infinity;

    for (const zone of zones) {
        if (!zone.active) continue;
        const strength = computeStrength(zone, index, decayBars, retestPenalty);
        if (strength > bestStrength) {
            bestStrength = strength;
            best = zone;
        }
    }

    return best;
}

function findEntryCandidates(
    zones: ZoneCandidates,
    bar: OHLCVData,
    index: number,
    minStrength: number,
    strengthDecayBars: number,
    retestPenalty: number
): {
    bestLong: Zone | null;
    bestLongStrength: number;
    bestShort: Zone | null;
    bestShortStrength: number;
} {
    let bestLong: Zone | null = null;
    let bestLongStrength = -Infinity;
    let bestShort: Zone | null = null;
    let bestShortStrength = -Infinity;

    for (const zone of zones.demand) {
        if (!zone.active || index <= zone.createdIndex) continue;
        const touched = bar.low <= zone.top && bar.high >= zone.bottom;
        const rejected = bar.close >= zone.top && bar.close > bar.open;
        if (!touched || !rejected) continue;

        const strength = computeStrength(zone, index, strengthDecayBars, retestPenalty);
        if (strength >= minStrength && strength > bestLongStrength) {
            bestLongStrength = strength;
            bestLong = zone;
        }
    }

    for (const zone of zones.supply) {
        if (!zone.active || index <= zone.createdIndex) continue;
        const touched = bar.high >= zone.bottom && bar.low <= zone.top;
        const rejected = bar.close <= zone.bottom && bar.close < bar.open;
        if (!touched || !rejected) continue;

        const strength = computeStrength(zone, index, strengthDecayBars, retestPenalty);
        if (strength >= minStrength && strength > bestShortStrength) {
            bestShortStrength = strength;
            bestShort = zone;
        }
    }

    return { bestLong, bestLongStrength, bestShort, bestShortStrength };
}

export const supply_demand_zones: Strategy = {
    name: 'Supply Demand Zones',
    description: 'Trades supply/demand zone rejections with structural exits (zone invalidation or opposite signal)',
    defaultParams: {
        swingLength: 12,
        zoneWidthAtr: 1.0,
        minStrength: 6,
    },
    paramLabels: {
        swingLength: 'Swing Length',
        zoneWidthAtr: 'Zone Width (ATR)',
        minStrength: 'Min Strength',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const swingLength = Math.max(2, Math.floor(params.swingLength));
        const zoneWidthAtr = clamp(params.zoneWidthAtr ?? 1.0, 0.2, 3);
        const minStrength = clamp(params.minStrength ?? 6, 1, 10);
        const atrPeriod = INTERNAL_ATR_PERIOD;
        const maxZones = INTERNAL_MAX_ZONES;
        const minZoneDistance = Math.max(1, Math.floor(swingLength * INTERNAL_MIN_ZONE_DISTANCE_MULTIPLIER));
        const invalidationMode = INTERNAL_INVALIDATION_MODE;
        const maxZoneAge = INTERNAL_MAX_ZONE_AGE;
        const strengthDecayBars = INTERNAL_STRENGTH_DECAY_BARS;
        const retestPenalty = INTERNAL_RETEST_PENALTY;

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, swingLength);

        const signals: Signal[] = [];
        const zones: ZoneCandidates = { supply: [], demand: [] };
        let lastSupplyCreated = -Infinity;
        let lastDemandCreated = -Infinity;

        let position: 'none' | 'long' | 'short' = 'none';
        let entryZone: Zone | null = null;

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];

            // Confirm pivots after swingLength bars
            const pivotIndex = i - swingLength;
            if (pivotIndex >= 0) {
                const atrVal = atr[pivotIndex];
                if (atrVal !== null && atrVal > 0) {
                    if (pivotHighs[pivotIndex] && i - lastSupplyCreated >= minZoneDistance) {
                        const zone = createSupplyZone(cleanData, pivotIndex, i, atrVal, zoneWidthAtr);
                        if (zone) {
                            zones.supply.push(zone);
                            lastSupplyCreated = i;
                            if (zones.supply.length > maxZones) zones.supply.shift();
                        }
                    }

                    if (pivotLows[pivotIndex] && i - lastDemandCreated >= minZoneDistance) {
                        const zone = createDemandZone(cleanData, pivotIndex, i, atrVal, zoneWidthAtr);
                        if (zone) {
                            zones.demand.push(zone);
                            lastDemandCreated = i;
                            if (zones.demand.length > maxZones) zones.demand.shift();
                        }
                    }
                }
            }

            // Update zones (invalidation and retests)
            for (const zone of zones.supply) {
                updateZoneState(zone, bar, i, invalidationMode, maxZoneAge);
            }
            for (const zone of zones.demand) {
                updateZoneState(zone, bar, i, invalidationMode, maxZoneAge);
            }

            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) continue;

            const { bestLong, bestLongStrength, bestShort, bestShortStrength } = findEntryCandidates(
                zones,
                bar,
                i,
                minStrength,
                strengthDecayBars,
                retestPenalty
            );

            if (position === 'none') {
                if (bestLong && (!bestShort || bestLongStrength >= bestShortStrength)) {
                    position = 'long';
                    entryZone = bestLong;
                    signals.push(createBuySignal(cleanData, i, 'Supply/Demand long entry'));
                } else if (bestShort) {
                    position = 'short';
                    entryZone = bestShort;
                    signals.push(createSellSignal(cleanData, i, 'Supply/Demand short entry'));
                }
            } else if (position === 'long') {
                const invalidated = entryZone === null || !entryZone.active || bar.close < entryZone.bottom;
                const oppositeShort = bestShort !== null && (!bestLong || bestShortStrength >= bestLongStrength);

                if (invalidated || oppositeShort) {
                    signals.push(createSellSignal(cleanData, i, invalidated ? 'Supply/Demand zone invalidated' : 'Supply/Demand opposite rejection'));
                    position = 'none';
                    entryZone = null;
                }
            } else if (position === 'short') {
                const invalidated = entryZone === null || !entryZone.active || bar.close > entryZone.top;
                const oppositeLong = bestLong !== null && (!bestShort || bestLongStrength >= bestShortStrength);

                if (invalidated || oppositeLong) {
                    signals.push(createBuySignal(cleanData, i, invalidated ? 'Supply/Demand zone invalidated' : 'Supply/Demand opposite rejection'));
                    position = 'none';
                    entryZone = null;
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const swingLength = Math.max(2, Math.floor(params.swingLength));
        const zoneWidthAtr = clamp(params.zoneWidthAtr ?? 1.0, 0.2, 3);
        const atrPeriod = INTERNAL_ATR_PERIOD;
        const maxZones = INTERNAL_MAX_ZONES;
        const minZoneDistance = Math.max(1, Math.floor(swingLength * INTERNAL_MIN_ZONE_DISTANCE_MULTIPLIER));
        const invalidationMode = INTERNAL_INVALIDATION_MODE;
        const maxZoneAge = INTERNAL_MAX_ZONE_AGE;
        const strengthDecayBars = INTERNAL_STRENGTH_DECAY_BARS;
        const retestPenalty = INTERNAL_RETEST_PENALTY;

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, swingLength);

        const supplyTop: (number | null)[] = new Array(cleanData.length).fill(null);
        const supplyBottom: (number | null)[] = new Array(cleanData.length).fill(null);
        const demandTop: (number | null)[] = new Array(cleanData.length).fill(null);
        const demandBottom: (number | null)[] = new Array(cleanData.length).fill(null);

        const zones: ZoneCandidates = { supply: [], demand: [] };
        let lastSupplyCreated = -Infinity;
        let lastDemandCreated = -Infinity;

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const pivotIndex = i - swingLength;

            if (pivotIndex >= 0) {
                const atrVal = atr[pivotIndex];
                if (atrVal !== null && atrVal > 0) {
                    if (pivotHighs[pivotIndex] && i - lastSupplyCreated >= minZoneDistance) {
                        const zone = createSupplyZone(cleanData, pivotIndex, i, atrVal, zoneWidthAtr);
                        if (zone) {
                            zones.supply.push(zone);
                            lastSupplyCreated = i;
                            if (zones.supply.length > maxZones) zones.supply.shift();
                        }
                    }

                    if (pivotLows[pivotIndex] && i - lastDemandCreated >= minZoneDistance) {
                        const zone = createDemandZone(cleanData, pivotIndex, i, atrVal, zoneWidthAtr);
                        if (zone) {
                            zones.demand.push(zone);
                            lastDemandCreated = i;
                            if (zones.demand.length > maxZones) zones.demand.shift();
                        }
                    }
                }
            }

            for (const zone of zones.supply) {
                updateZoneState(zone, bar, i, invalidationMode, maxZoneAge);
            }
            for (const zone of zones.demand) {
                updateZoneState(zone, bar, i, invalidationMode, maxZoneAge);
            }

            const bestSupply = selectStrongestZone(zones.supply, i, strengthDecayBars, retestPenalty);
            const bestDemand = selectStrongestZone(zones.demand, i, strengthDecayBars, retestPenalty);

            supplyTop[i] = bestSupply ? bestSupply.top : null;
            supplyBottom[i] = bestSupply ? bestSupply.bottom : null;
            demandTop[i] = bestDemand ? bestDemand.top : null;
            demandBottom[i] = bestDemand ? bestDemand.bottom : null;
        }

        return [
            { name: 'Supply Top', type: 'line', values: supplyTop, color: COLORS.Trend },
            { name: 'Supply Bottom', type: 'line', values: supplyBottom, color: COLORS.Trend },
            { name: 'Demand Top', type: 'line', values: demandTop, color: COLORS.Positive },
            { name: 'Demand Bottom', type: 'line', values: demandBottom, color: COLORS.Positive },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Neutral },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};


