import { OHLCVData, Trade } from "../../types/index";
import { IndicatorSeries, NormalizedSettings, PositionState } from "../../types/backtest";

export interface AdaptiveTakeProfitOverrides {
    takeProfitPercent: number | null;
}

export interface AdaptiveTakeProfitExitSignal {
    exitPrice: number;
    exitReason: NonNullable<Trade["exitReason"]>;
    deferExecutionToNextBarOpen?: boolean;
}

interface AdaptivePositionTakeProfitState {
    registered: true;
}

export interface AdaptiveTakeProfitState {
    positionStates: WeakMap<PositionState, AdaptivePositionTakeProfitState>;
    mfeBootstrapPercent: number | null;
}

function calculatePercentile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const rank = (Math.max(1, Math.min(99, percentile)) / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    if (lowerIndex === upperIndex) return sorted[lowerIndex];

    const weight = rank - lowerIndex;
    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

function clampNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Pre-computes the MFE-bootstrap TP% from the full dataset by simulating a
 * naive forward pass to identify bars where buy/sell MFE is measurable.
 * This is intentionally NON-CAUSAL and uses the full dataset.
 */
function computeMfeBootstrapPercent(
    data: OHLCVData[],
    config: NormalizedSettings
): number | null {
    if (data.length < 20) return null;

    const mfePercents: number[] = [];
    const lookforward = Math.max(5, Math.min(50, Math.round(data.length * 0.02)));

    for (let i = 1; i < data.length - lookforward; i++) {
        const entryPrice = data[i].close;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

        let bestLongMfe = 0;
        let bestShortMfe = 0;
        for (let j = i + 1; j <= i + lookforward && j < data.length; j++) {
            const longMfe = ((data[j].high - entryPrice) / entryPrice) * 100;
            const shortMfe = ((entryPrice - data[j].low) / entryPrice) * 100;
            if (longMfe > bestLongMfe) bestLongMfe = longMfe;
            if (shortMfe > bestShortMfe) bestShortMfe = shortMfe;
        }
        if (bestLongMfe > 0) mfePercents.push(bestLongMfe);
        if (bestShortMfe > 0) mfePercents.push(bestShortMfe);
    }

    return calculatePercentile(mfePercents, config.takeProfitMfeBootstrapPercentile);
}

export function createAdaptiveTakeProfitState(
    data: OHLCVData[],
    config: NormalizedSettings,
    _indicators: IndicatorSeries,
    _initialCapital: number
): AdaptiveTakeProfitState {
    let mfeBootstrapPercent: number | null = null;
    if (config.takeProfitMode === "mfe_bootstrap" && config.riskMode === "percentage" && config.takeProfitEnabled) {
        mfeBootstrapPercent = computeMfeBootstrapPercent(data, config);
    }
    return {
        positionStates: new WeakMap<PositionState, AdaptivePositionTakeProfitState>(),
        mfeBootstrapPercent,
    };
}

export function resolveAdaptiveTakeProfitOverrides(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    _direction: "long" | "short",
    _entryPrice: number,
    _entryBarIndex: number
): AdaptiveTakeProfitOverrides | null {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) {
        return null;
    }

    if (config.takeProfitMode === "mfe_bootstrap") {
        return {
            takeProfitPercent: state.mfeBootstrapPercent !== null && state.mfeBootstrapPercent > 0
                ? state.mfeBootstrapPercent
                : clampNonNegative(config.takeProfitPercent),
        };
    }

    return {
        takeProfitPercent: clampNonNegative(config.takeProfitPercent),
    };
}

export function registerAdaptiveTakeProfitPosition(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    _entryBarIndex: number
): void {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) return;

    state.positionStates.set(position, { registered: true });
}

export function updateAdaptiveTakeProfitPosition(
    _config: NormalizedSettings,
    _state: AdaptiveTakeProfitState,
    _position: PositionState,
    _candle: OHLCVData,
    _barIndex: number
): AdaptiveTakeProfitExitSignal | null {
    return null;
}

export function updateAdaptiveTakeProfitHistory(
    _config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    _exitPrice: number,
    _exitReason: NonNullable<Trade["exitReason"]>,
    _candle: OHLCVData,
    _closedCapital: number
): void {
    state.positionStates.delete(position);
}
