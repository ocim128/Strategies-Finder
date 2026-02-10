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
    forceAtr: number
): Zone | null {
    const bar = data[pivotIndex];
    let top = bar.high;
    let bottom = Math.min(bar.open, bar.close);

    let height = top - bottom;
    if (height <= 0) return null;

    if (forceAtr > 0 && height < atrValue * forceAtr) {
        height = atrValue * forceAtr;
        bottom = top - height;
    }

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
    forceAtr: number
): Zone | null {
    const bar = data[pivotIndex];
    let bottom = bar.low;
    let top = Math.max(bar.open, bar.close);

    let height = top - bottom;
    if (height <= 0) return null;

    if (forceAtr > 0 && height < atrValue * forceAtr) {
        height = atrValue * forceAtr;
        top = bottom + height;
    }

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

function filterZoneByAtr(height: number, atrValue: number, minAtr: number, maxAtr: number): boolean {
    if (atrValue <= 0) return false;
    if (maxAtr > 0 && height > atrValue * maxAtr) return false;
    if (minAtr > 0 && height < atrValue * minAtr) return false;
    return true;
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

export const supply_demand_zones: Strategy = {
    name: 'Supply Demand Zones',
    description: 'Trades fresh supply/demand zones using pivot swings, ATR filters, and strength ranking',
    defaultParams: {
        swingLength: 12,
        maxZones: 10,
        maxZoneAtr: 1.0,
        minZoneAtr: 1.0,
        forceZoneAtr: 1.0,
        minZoneDistance: 44,
        invalidationMode: 0,
        maxZoneAge: 1000,
        atrPeriod: 14,
        strengthDecayBars: 200,
        retestPenalty: 1.5,
        minStrength: 6,
        stopAtrMult: 1.0,
        targetAtrMult: 2.0,
    },
    paramLabels: {
        swingLength: 'Swing Length',
        maxZones: 'Max Zones',
        maxZoneAtr: 'Max Zone Height (ATR)',
        minZoneAtr: 'Min Zone Height (ATR)',
        forceZoneAtr: 'Force Zone Height (ATR)',
        minZoneDistance: 'Min Distance Between Zones (bars)',
        invalidationMode: 'Invalidation Mode (0=Close, 1=Wick)',
        maxZoneAge: 'Max Zone Age (bars)',
        atrPeriod: 'ATR Period',
        strengthDecayBars: 'Strength Decay Bars',
        retestPenalty: 'Retest Penalty',
        minStrength: 'Min Strength',
        stopAtrMult: 'Stop ATR Mult',
        targetAtrMult: 'Target ATR Mult',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const swingLength = Math.max(2, Math.floor(params.swingLength));
        const maxZones = Math.max(1, Math.floor(params.maxZones));
        const maxZoneAtr = Math.max(0, params.maxZoneAtr ?? 0);
        const minZoneAtr = Math.max(0, params.minZoneAtr ?? 0);
        const forceZoneAtr = Math.max(0, params.forceZoneAtr ?? 0);
        const minZoneDistance = Math.max(0, Math.floor(params.minZoneDistance));
        const invalidationMode = Math.round(params.invalidationMode ?? 0);
        const maxZoneAge = Math.max(0, Math.floor(params.maxZoneAge ?? 0));
        const atrPeriod = Math.max(2, Math.floor(params.atrPeriod));
        const strengthDecayBars = Math.max(1, Math.floor(params.strengthDecayBars));
        const retestPenalty = Math.max(0, params.retestPenalty ?? 1.5);
        const minStrength = clamp(params.minStrength ?? 6, 1, 10);
        const stopAtrMult = Math.max(0, params.stopAtrMult ?? 1.0);
        const targetAtrMult = Math.max(0.1, params.targetAtrMult ?? 2.0);

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
        let stopPrice = 0;
        let targetPrice = 0;

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];

            // Confirm pivots after swingLength bars
            const pivotIndex = i - swingLength;
            if (pivotIndex >= 0) {
                const atrVal = atr[pivotIndex];
                if (atrVal !== null && atrVal > 0) {
                    if (pivotHighs[pivotIndex] && i - lastSupplyCreated >= minZoneDistance) {
                        const zone = createSupplyZone(cleanData, pivotIndex, i, atrVal, forceZoneAtr);
                        if (zone) {
                            const height = zone.top - zone.bottom;
                            if (filterZoneByAtr(height, atrVal, minZoneAtr, maxZoneAtr)) {
                                zones.supply.push(zone);
                                lastSupplyCreated = i;
                                if (zones.supply.length > maxZones) zones.supply.shift();
                            }
                        }
                    }

                    if (pivotLows[pivotIndex] && i - lastDemandCreated >= minZoneDistance) {
                        const zone = createDemandZone(cleanData, pivotIndex, i, atrVal, forceZoneAtr);
                        if (zone) {
                            const height = zone.top - zone.bottom;
                            if (filterZoneByAtr(height, atrVal, minZoneAtr, maxZoneAtr)) {
                                zones.demand.push(zone);
                                lastDemandCreated = i;
                                if (zones.demand.length > maxZones) zones.demand.shift();
                            }
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

            if (position === 'none') {
                let bestLong: Zone | null = null;
                let bestLongStrength = -Infinity;
                let bestShort: Zone | null = null;
                let bestShortStrength = -Infinity;

                for (const zone of zones.demand) {
                    if (!zone.active || i <= zone.createdIndex) continue;
                    const touched = bar.low <= zone.top && bar.high >= zone.bottom;
                    const rejected = bar.close >= zone.top && bar.close > bar.open;
                    if (!touched || !rejected) continue;

                    const strength = computeStrength(zone, i, strengthDecayBars, retestPenalty);
                    if (strength >= minStrength && strength > bestLongStrength) {
                        bestLongStrength = strength;
                        bestLong = zone;
                    }
                }

                for (const zone of zones.supply) {
                    if (!zone.active || i <= zone.createdIndex) continue;
                    const touched = bar.high >= zone.bottom && bar.low <= zone.top;
                    const rejected = bar.close <= zone.bottom && bar.close < bar.open;
                    if (!touched || !rejected) continue;

                    const strength = computeStrength(zone, i, strengthDecayBars, retestPenalty);
                    if (strength >= minStrength && strength > bestShortStrength) {
                        bestShortStrength = strength;
                        bestShort = zone;
                    }
                }

                if (bestLong && (!bestShort || bestLongStrength >= bestShortStrength)) {
                    position = 'long';
                    stopPrice = bestLong.bottom - atrNow * stopAtrMult;
                    targetPrice = bar.close + atrNow * targetAtrMult;
                    signals.push(createBuySignal(cleanData, i, 'Supply/Demand long entry'));
                } else if (bestShort) {
                    position = 'short';
                    stopPrice = bestShort.top + atrNow * stopAtrMult;
                    targetPrice = bar.close - atrNow * targetAtrMult;
                    signals.push(createSellSignal(cleanData, i, 'Supply/Demand short entry'));
                }
            } else if (position === 'long') {
                const hitStop = bar.low <= stopPrice;
                const hitTarget = bar.high >= targetPrice;

                if (hitStop || hitTarget) {
                    signals.push(createSellSignal(cleanData, i, hitStop ? 'Supply/Demand stop' : 'Supply/Demand target'));
                    position = 'none';
                    stopPrice = 0;
                    targetPrice = 0;
                }
            } else if (position === 'short') {
                const hitStop = bar.high >= stopPrice;
                const hitTarget = bar.low <= targetPrice;

                if (hitStop || hitTarget) {
                    signals.push(createBuySignal(cleanData, i, hitStop ? 'Supply/Demand stop' : 'Supply/Demand target'));
                    position = 'none';
                    stopPrice = 0;
                    targetPrice = 0;
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const swingLength = Math.max(2, Math.floor(params.swingLength));
        const maxZones = Math.max(1, Math.floor(params.maxZones));
        const maxZoneAtr = Math.max(0, params.maxZoneAtr ?? 0);
        const minZoneAtr = Math.max(0, params.minZoneAtr ?? 0);
        const forceZoneAtr = Math.max(0, params.forceZoneAtr ?? 0);
        const minZoneDistance = Math.max(0, Math.floor(params.minZoneDistance));
        const invalidationMode = Math.round(params.invalidationMode ?? 0);
        const maxZoneAge = Math.max(0, Math.floor(params.maxZoneAge ?? 0));
        const atrPeriod = Math.max(2, Math.floor(params.atrPeriod));
        const strengthDecayBars = Math.max(1, Math.floor(params.strengthDecayBars));
        const retestPenalty = Math.max(0, params.retestPenalty ?? 1.5);

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
                        const zone = createSupplyZone(cleanData, pivotIndex, i, atrVal, forceZoneAtr);
                        if (zone) {
                            const height = zone.top - zone.bottom;
                            if (filterZoneByAtr(height, atrVal, minZoneAtr, maxZoneAtr)) {
                                zones.supply.push(zone);
                                lastSupplyCreated = i;
                                if (zones.supply.length > maxZones) zones.supply.shift();
                            }
                        }
                    }

                    if (pivotLows[pivotIndex] && i - lastDemandCreated >= minZoneDistance) {
                        const zone = createDemandZone(cleanData, pivotIndex, i, atrVal, forceZoneAtr);
                        if (zone) {
                            const height = zone.top - zone.bottom;
                            if (filterZoneByAtr(height, atrVal, minZoneAtr, maxZoneAtr)) {
                                zones.demand.push(zone);
                                lastDemandCreated = i;
                                if (zones.demand.length > maxZones) zones.demand.shift();
                            }
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


