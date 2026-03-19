import { OHLCVData, Trade } from "../../types/index";
import { IndicatorSeries, NormalizedSettings, PositionState } from "../../types/backtest";
import { directionFactorFor } from "./backtest-utils";

export interface AdaptiveTakeProfitOverrides {
    takeProfitPercent: number | null;
}

export interface AdaptiveTakeProfitExitSignal {
    exitPrice: number;
    exitReason: NonNullable<Trade["exitReason"]>;
    deferExecutionToNextBarOpen?: boolean;
}

interface AdaptivePerformanceState {
    consecutiveLosses: number;
    currentClosedCapital: number;
    peakClosedCapital: number;
}

interface AdaptivePositionTakeProfitState {
    mode: NonNullable<NormalizedSettings["takeProfitMode"]>;
    entryBarIndex: number;
    initialTargetPercent: number | null;
    currentTargetPercent: number | null;
    velocityResolved: boolean;
    peakDirectionalRsi: number | null;
}

export interface AdaptiveTakeProfitState {
    longWinningMfePercents: number[];
    shortWinningMfePercents: number[];
    positionStates: WeakMap<PositionState, AdaptivePositionTakeProfitState>;
    indicators: Pick<
        IndicatorSeries,
        | "rsi"
        | "volumeSma"
        | "sessionVwap"
        | "vwapDeviationStd"
    >;
    performance: AdaptivePerformanceState;
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

function greaterThanOrNearlyEqual(left: number, right: number): boolean {
    const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right), 1) * 1e-12);
    return left > right || Math.abs(left - right) <= tolerance;
}

function toTargetPrice(entryPrice: number, direction: "long" | "short", percent: number): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(percent) || percent <= 0) {
        return null;
    }

    const directionFactor = directionFactorFor(direction);
    return entryPrice * (1 + directionFactor * (percent / 100));
}

function toTargetPercent(entryPrice: number, targetPrice: number | null): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || targetPrice === null || !Number.isFinite(targetPrice)) {
        return null;
    }

    return Math.abs(((targetPrice - entryPrice) / entryPrice) * 100);
}

function getDirectionHistory(
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number[] {
    return direction === "long" ? state.longWinningMfePercents : state.shortWinningMfePercents;
}

function getRecentWinningMfePercents(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number[] {
    const history = getDirectionHistory(state, direction);
    const lookback = Math.max(1, config.takeProfitMfeLookbackTrades);
    return history.length <= lookback ? history : history.slice(history.length - lookback);
}

function resolveRollingMfePercent(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number {
    const recentHistory = getRecentWinningMfePercents(config, state, direction);
    return clampNonNegative(
        calculatePercentile(recentHistory, config.takeProfitMfePercentile) ?? config.takeProfitPercent
    );
}

function resolveEntryAdaptiveTargetPercent(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number {
    if (config.takeProfitMode === "shrinkage") {
        const pairEstimate = resolveRollingMfePercent(config, state, direction);
        const recentHistory = getRecentWinningMfePercents(config, state, direction);
        const sampleWeight = recentHistory.length / (recentHistory.length + config.takeProfitShrinkageStrength);
        return clampNonNegative(
            sampleWeight * pairEstimate + (1 - sampleWeight) * config.takeProfitPercent
        );
    }

    return clampNonNegative(config.takeProfitPercent);
}

function resolveDirectionalRsi(rawRsi: number | null | undefined, direction: "long" | "short"): number | null {
    if (!Number.isFinite(rawRsi)) return null;
    return direction === "long" ? rawRsi! : 100 - rawRsi!;
}

function resolveDirectionalMovePercent(entryPrice: number, price: number, direction: "long" | "short"): number {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(price)) return 0;
    return directionFactorFor(direction) * ((price - entryPrice) / entryPrice) * 100;
}

export function createAdaptiveTakeProfitState(
    _data: OHLCVData[],
    _config: NormalizedSettings,
    indicators: IndicatorSeries,
    initialCapital: number
): AdaptiveTakeProfitState {
    return {
        longWinningMfePercents: [],
        shortWinningMfePercents: [],
        positionStates: new WeakMap<PositionState, AdaptivePositionTakeProfitState>(),
        indicators: {
            rsi: indicators.rsi,
            volumeSma: indicators.volumeSma,
            sessionVwap: indicators.sessionVwap,
            vwapDeviationStd: indicators.vwapDeviationStd,
        },
        performance: {
            consecutiveLosses: 0,
            currentClosedCapital: initialCapital,
            peakClosedCapital: initialCapital,
        },
    };
}

export function resolveAdaptiveTakeProfitOverrides(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short",
    _entryPrice: number,
    _entryBarIndex: number
): AdaptiveTakeProfitOverrides | null {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) {
        return null;
    }

    const adaptivePercent = resolveEntryAdaptiveTargetPercent(config, state, direction);

    return {
        takeProfitPercent: adaptivePercent,
    };
}

export function registerAdaptiveTakeProfitPosition(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    entryBarIndex: number
): void {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) return;

    state.positionStates.set(position, {
        mode: config.takeProfitMode,
        entryBarIndex,
        initialTargetPercent: toTargetPercent(position.entryPrice, position.takeProfitPrice),
        currentTargetPercent: toTargetPercent(position.entryPrice, position.takeProfitPrice),
        velocityResolved: false,
        peakDirectionalRsi: null,
    });
}

export function updateAdaptiveTakeProfitPosition(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    candle: OHLCVData,
    barIndex: number
): AdaptiveTakeProfitExitSignal | null {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) return null;

    const positionState = state.positionStates.get(position);
    if (!positionState) return null;

    if (positionState.mode === "momentum_gated" && positionState.currentTargetPercent !== null) {
        const profitableClose = resolveDirectionalMovePercent(position.entryPrice, candle.close, position.direction) > 0;
        const currentDirectionalRsi = resolveDirectionalRsi(state.indicators.rsi[barIndex], position.direction);
        const previousDirectionalRsi = resolveDirectionalRsi(state.indicators.rsi[barIndex - 1], position.direction);

        if (Number.isFinite(currentDirectionalRsi)) {
            positionState.peakDirectionalRsi = positionState.peakDirectionalRsi === null
                ? currentDirectionalRsi!
                : Math.max(positionState.peakDirectionalRsi, currentDirectionalRsi!);
        }

        const gateActive =
            profitableClose
            && Number.isFinite(currentDirectionalRsi)
            && Number.isFinite(previousDirectionalRsi)
            && currentDirectionalRsi! >= config.takeProfitMomentumRsiPauseLevel
            && currentDirectionalRsi! >= previousDirectionalRsi!;

        if (!gateActive && profitableClose) {
            const floorPercent = Math.max(
                0.1,
                (positionState.initialTargetPercent ?? config.takeProfitPercent) * 0.25
            );
            positionState.currentTargetPercent = Math.max(
                floorPercent,
                positionState.currentTargetPercent - config.takeProfitMomentumDecayPercentPerBar
            );
            position.takeProfitPrice = toTargetPrice(position.entryPrice, position.direction, positionState.currentTargetPercent);
        }
    }

    if (
        positionState.mode === "velocity"
        && !positionState.velocityResolved
        && positionState.initialTargetPercent !== null
        && positionState.initialTargetPercent > 0
        && positionState.currentTargetPercent !== null
    ) {
        const favorableMovePercent = Math.max(
            0,
            resolveDirectionalMovePercent(position.entryPrice, position.extremePrice, position.direction)
        );
        const progressPercent = (favorableMovePercent / positionState.initialTargetPercent) * 100;

        if (
            position.barsInTrade <= config.takeProfitVelocityFastBars
            && greaterThanOrNearlyEqual(progressPercent, config.takeProfitVelocityProgressPercent)
        ) {
            positionState.currentTargetPercent *= config.takeProfitVelocityExpandMultiplier;
            positionState.velocityResolved = true;
            position.takeProfitPrice = toTargetPrice(position.entryPrice, position.direction, positionState.currentTargetPercent);
        } else if (
            position.barsInTrade >= config.takeProfitVelocitySlowBars
            && !greaterThanOrNearlyEqual(progressPercent, config.takeProfitVelocityProgressPercent)
        ) {
            positionState.currentTargetPercent *= config.takeProfitVelocityShrinkMultiplier;
            positionState.velocityResolved = true;
            position.takeProfitPrice = toTargetPrice(position.entryPrice, position.direction, positionState.currentTargetPercent);
        }
    }

    return null;
}

export function updateAdaptiveTakeProfitHistory(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    exitPrice: number,
    exitReason: NonNullable<Trade["exitReason"]>,
    candle: OHLCVData,
    closedCapital: number
): void {
    state.performance.currentClosedCapital = closedCapital;
    if (closedCapital > state.performance.peakClosedCapital) {
        state.performance.peakClosedCapital = closedCapital;
    }
    state.performance.consecutiveLosses = position.realizedPnl > 0
        ? 0
        : state.performance.consecutiveLosses + 1;

    state.positionStates.delete(position);

    if (config.riskMode !== "percentage") return;
    if (config.takeProfitMode !== "shrinkage") return;
    if (!Number.isFinite(position.realizedPnl) || position.realizedPnl <= 0) return;
    if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) return;
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;

    const canUseFullExitBarRange =
        exitReason === "time_stop"
        || (exitReason === "signal" && config.executionModel !== "next_open");

    const mostFavorablePrice = position.direction === "short"
        ? (canUseFullExitBarRange
            ? Math.min(position.extremePrice, candle.low)
            : Math.min(position.extremePrice, exitPrice))
        : (canUseFullExitBarRange
            ? Math.max(position.extremePrice, candle.high)
            : Math.max(position.extremePrice, exitPrice));
    const mfePercent = Math.abs(((mostFavorablePrice - position.entryPrice) / position.entryPrice) * 100);
    if (!Number.isFinite(mfePercent) || mfePercent <= 0) return;

    const history = getDirectionHistory(state, position.direction);
    history.push(mfePercent);

    const maxHistory = Math.max(25, config.takeProfitMfeLookbackTrades * 2);
    if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
    }
}
