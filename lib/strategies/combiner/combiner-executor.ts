// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner - Execution Logic
// ═══════════════════════════════════════════════════════════════════════════
//
// This module handles trade execution based on combined signals.
// It implements an explicit state machine with clear rules:
// - OPEN trade only when openCondition = true
// - DO NOTHING when openCondition = false
// - CLOSE trade only if explicitly defined in closeCondition
// - "No trade" and "Close trade" are separate modes
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Signal, OHLCVData, Time } from '../types';
import {
    CombinedSignal,
    CombinedStrategyDefinition,
    ExecutionContext,
    ExecutionResult,
    ExecutionRules,
    ShortHandling,
    CombinationNode,
} from './combiner-types';
import { evaluateNode } from './combiner-engine';
import { strategies } from '../library';
import { resampleOHLCV, getIntervalSeconds } from '../resample-utils';

// ═══════════════════════════════════════════════════════════════════════════
// POSITION STATE
// ═══════════════════════════════════════════════════════════════════════════

export type PositionState = 'flat' | 'long' | 'short';

export interface ExecutorState {
    position: PositionState;
    entryTime: Time | null;
    entryPrice: number | null;
    entryReason: string | null;
}

export function createInitialState(): ExecutorState {
    return {
        position: 'flat',
        entryTime: null,
        entryPrice: null,
        entryReason: null,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export type ExecutionAction =
    | 'OPEN_LONG'
    | 'OPEN_SHORT'
    | 'CLOSE_LONG'
    | 'CLOSE_SHORT'
    | 'DO_NOTHING';

/**
 * Determines the execution action based on current position and signals
 */
export function determineAction(
    context: ExecutionContext
): ExecutionResult {
    const { currentPosition, combinedSignal, rules, shortEnabled } = context;

    // ─────────────────────────────────────────────────────────────────────
    // FLAT POSITION - Looking for entry
    // ─────────────────────────────────────────────────────────────────────
    if (currentPosition === 'flat') {
        if (combinedSignal === 'BUY') {
            return {
                action: 'OPEN_LONG',
                reason: 'Open condition triggered: BUY signal while flat',
            };
        }

        if (combinedSignal === 'SELL' && shortEnabled) {
            return {
                action: 'OPEN_SHORT',
                reason: 'Open condition triggered: SELL signal while flat (short enabled)',
            };
        }

        return {
            action: 'DO_NOTHING',
            reason: currentPosition === 'flat' && combinedSignal === 'SELL' && !shortEnabled
                ? 'SELL signal ignored: short positions disabled'
                : 'No entry signal',
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // LONG POSITION - Looking for exit
    // ─────────────────────────────────────────────────────────────────────
    if (currentPosition === 'long') {
        // Check explicit close condition first
        if (rules.closeCondition) {
            // Close condition is evaluated separately via evaluateCloseCondition
            // Here we just handle the signal-based exit
        }

        // Exit on opposite signal
        if (combinedSignal === 'SELL') {
            return {
                action: 'CLOSE_LONG',
                reason: 'Exit condition: SELL signal while long',
            };
        }

        return {
            action: 'DO_NOTHING',
            reason: 'Holding long position',
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // SHORT POSITION - Looking for exit
    // ─────────────────────────────────────────────────────────────────────
    if (currentPosition === 'short') {
        // Exit on opposite signal
        if (combinedSignal === 'BUY') {
            return {
                action: 'CLOSE_SHORT',
                reason: 'Exit condition: BUY signal while short',
            };
        }

        return {
            action: 'DO_NOTHING',
            reason: 'Holding short position',
        };
    }

    return {
        action: 'DO_NOTHING',
        reason: 'Unknown position state',
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOSE CONDITION EVALUATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates the explicit close condition if defined
 * Returns true if position should be closed
 */
export function evaluateCloseCondition(
    closeCondition: CombinationNode | undefined,
    currentPosition: PositionState,
    timeKey: string,
    signalMaps: Map<string, Map<string, CombinedSignal>>
): boolean {
    if (!closeCondition) return false;
    if (currentPosition === 'flat') return false;

    const closeSignal = evaluateNode(closeCondition, timeKey, signalMaps);

    // For long positions, close on SELL signal from close condition
    if (currentPosition === 'long' && closeSignal === 'SELL') {
        return true;
    }

    // For short positions, close on BUY signal from close condition
    if (currentPosition === 'short' && closeSignal === 'BUY') {
        return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHORT HANDLING LOGIC
// ═══════════════════════════════════════════════════════════════════════════

export interface DirectionSignals {
    longSignal: CombinedSignal;
    shortSignal: CombinedSignal;
}

/**
 * Evaluates independent long and short signals when short handling is enabled
 */
export function evaluateDirectionSignals(
    shortHandling: ShortHandling,
    openCondition: CombinationNode,
    timeKey: string,
    signalMaps: Map<string, Map<string, CombinedSignal>>
): DirectionSignals {
    if (!shortHandling.enabled) {
        // When shorts disabled, only evaluate for long
        const signal = evaluateNode(openCondition, timeKey, signalMaps);
        return {
            longSignal: signal === 'BUY' ? 'BUY' : 'NO_SIGNAL',
            shortSignal: 'NO_SIGNAL',
        };
    }

    // Independent long logic
    const longSignal = shortHandling.longLogic
        ? evaluateNode(shortHandling.longLogic, timeKey, signalMaps)
        : evaluateNode(openCondition, timeKey, signalMaps);

    // Independent short logic
    const shortSignal = shortHandling.shortLogic
        ? evaluateNode(shortHandling.shortLogic, timeKey, signalMaps)
        : evaluateNode(openCondition, timeKey, signalMaps);

    return {
        longSignal: longSignal === 'BUY' ? 'BUY' : 'NO_SIGNAL',
        shortSignal: shortSignal === 'SELL' ? 'SELL' : 'NO_SIGNAL',
    };
}


/**
 * Resolves which direction to trade when both long and short signals fire
 */
export function resolveDirectionConflict(
    signals: DirectionSignals,
    priority: 'long' | 'short' | 'none' = 'long'
): CombinedSignal {
    const hasLong = signals.longSignal === 'BUY';
    const hasShort = signals.shortSignal === 'SELL';

    if (hasLong && hasShort) {
        // Both signals fired - use priority
        switch (priority) {
            case 'long': return 'BUY';
            case 'short': return 'SELL';
            case 'none': return 'NO_SIGNAL';
        }
    }

    if (hasLong) return 'BUY';
    if (hasShort) return 'SELL';
    return 'NO_SIGNAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Applies an execution action to the current state
 * Returns the new state after the action
 */
export function applyAction(
    state: ExecutorState,
    action: ExecutionAction,
    bar: OHLCVData,
    reason: string
): ExecutorState {
    switch (action) {
        case 'OPEN_LONG':
            return {
                position: 'long',
                entryTime: bar.time,
                entryPrice: bar.close,
                entryReason: reason,
            };

        case 'OPEN_SHORT':
            return {
                position: 'short',
                entryTime: bar.time,
                entryPrice: bar.close,
                entryReason: reason,
            };

        case 'CLOSE_LONG':
        case 'CLOSE_SHORT':
            return {
                position: 'flat',
                entryTime: null,
                entryPrice: null,
                entryReason: null,
            };

        case 'DO_NOTHING':
        default:
            return state;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecutorConfig {
    definition: CombinedStrategyDefinition;
    directionPriority?: 'long' | 'short' | 'none';
}

export interface ExecutorOutput {
    signals: Signal[];
    actions: Array<{ time: Time; action: ExecutionAction; reason: string }>;
    finalState: ExecutorState;
}

/**
 * Converts Time to a string key for map lookup
 */
function timeToKey(time: Time): string {
    if (typeof time === 'number') return time.toString();
    if (typeof time === 'string') return time;
    return `${time.year}-${time.month}-${time.day}`;
}

/**
 * Executes a combined strategy definition on OHLCV data
 * Returns signals compatible with the existing backtesting system
 */
export function executeStrategy(
    config: ExecutorConfig,
    data: OHLCVData[]
): ExecutorOutput {
    const { definition, directionPriority = 'long' } = config;
    const signals: Signal[] = [];
    const actions: Array<{ time: Time; action: ExecutionAction; reason: string }> = [];

    // Build signal maps for all input strategies
    // IMPORTANT: Use meta.id as key (string) because object reference equality won't work
    const signalMaps = new Map<string, Map<string, CombinedSignal>>();

    // Infer base interval from data (default to 60s if not detectable)
    const baseIntervalSeconds = data.length > 1 && typeof data[0].time === 'number' && typeof data[1].time === 'number'
        ? (data[1].time as number) - (data[0].time as number)
        : 60;

    for (const meta of definition.inputStrategies) {
        const strategy = strategies[meta.strategyId];
        if (!strategy) continue;

        const params = meta.params ?? strategy.defaultParams;
        const strategyTimeframe = meta.timeframe;
        const strategyIntervalSeconds = strategyTimeframe ? getIntervalSeconds(strategyTimeframe) : baseIntervalSeconds;

        // Use resampled data if higher timeframe requested
        let execData = data;
        let isHTF = strategyIntervalSeconds > baseIntervalSeconds;

        if (isHTF && strategyTimeframe) {
            execData = resampleOHLCV(data, strategyTimeframe);
        }

        const strategySignals = strategy.execute(execData, params);
        const signalMap = new Map<string, CombinedSignal>();

        if (isHTF) {
            // Mapping HTF signals back to base timeframe bars
            // We expand signals to avoid missing them during AND/OR operations
            if (meta.role === 'filter') {
                // FILTER: Persist last signal until next signal arrives
                // This allows HTF filters to stay active across multiple HTF bars
                let currentSignal: CombinedSignal = 'NO_SIGNAL';
                let signalIdx = 0;

                // Sort signals by time
                const sortedSignals = [...strategySignals].sort((a, b) =>
                    (typeof a.time === 'number' ? a.time : 0) - (typeof b.time === 'number' ? b.time : 0)
                );

                for (const bar of data) {
                    const barTime = typeof bar.time === 'number' ? bar.time : 0;

                    // Check if a new signal should be active
                    // HTF signals are available AFTER the HTF bar closes
                    while (signalIdx < sortedSignals.length) {
                        const sigTime = typeof sortedSignals[signalIdx].time === 'number' ? (sortedSignals[signalIdx].time as number) : 0;
                        const validFrom = sigTime + strategyIntervalSeconds;

                        if (barTime >= validFrom) {
                            currentSignal = sortedSignals[signalIdx].type === 'buy' ? 'BUY' : 'SELL';
                            signalIdx++;
                        } else {
                            break;
                        }
                    }

                    if (currentSignal !== 'NO_SIGNAL') {
                        signalMap.set(barTime.toString(), currentSignal);
                    }
                }
            } else {
                // ENTRY: Expand only for the duration of the HTF bar
                // This allows lower-timeframe filters to coincide with HTF entry triggers
                for (const sig of strategySignals) {
                    const sigTime = typeof sig.time === 'number' ? (sig.time as number) : 0;
                    const sigType: CombinedSignal = sig.type === 'buy' ? 'BUY' : 'SELL';
                    const validFrom = sigTime + strategyIntervalSeconds;

                    for (let t = validFrom; t < validFrom + strategyIntervalSeconds; t += baseIntervalSeconds) {
                        signalMap.set(t.toString(), sigType);
                    }
                }
            }
        } else {
            // Standard mapping for same timeframe
            for (const sig of strategySignals) {
                const key = timeToKey(sig.time);
                signalMap.set(key, sig.type === 'buy' ? 'BUY' : 'SELL');
            }
        }

        signalMaps.set(meta.id, signalMap);
    }

    // Initialize state
    let state = createInitialState();

    // Process each bar
    for (const bar of data) {
        const key = timeToKey(bar.time);

        // Evaluate direction signals
        const directionSignals = evaluateDirectionSignals(
            definition.shortHandling,
            definition.executionRules.openCondition,
            key,
            signalMaps
        );

        // Resolve direction if both fire
        const combinedSignal = resolveDirectionConflict(directionSignals, directionPriority);

        // Check explicit close condition
        const shouldClose = evaluateCloseCondition(
            definition.executionRules.closeCondition,
            state.position,
            key,
            signalMaps
        );

        // Build execution context
        const context: ExecutionContext = {
            currentPosition: state.position,
            combinedSignal: shouldClose
                ? (state.position === 'long' ? 'SELL' : 'BUY')
                : combinedSignal,
            rules: definition.executionRules,
            shortEnabled: definition.shortHandling.enabled,
        };

        // Determine action
        const result = determineAction(context);

        // Override with close condition result
        if (shouldClose && state.position !== 'flat') {
            if (state.position === 'long') {
                result.action = 'CLOSE_LONG';
                result.reason = 'Explicit close condition triggered';
            } else {
                result.action = 'CLOSE_SHORT';
                result.reason = 'Explicit close condition triggered';
            }
        }

        // Record action
        if (result.action !== 'DO_NOTHING') {
            actions.push({
                time: bar.time,
                action: result.action,
                reason: result.reason,
            });

            // Generate signal for backtest system
            if (result.action === 'OPEN_LONG' || result.action === 'CLOSE_SHORT') {
                signals.push({
                    time: bar.time,
                    type: 'buy',
                    price: bar.close,
                    reason: `[${definition.name}] ${result.reason}`,
                });
            } else if (result.action === 'OPEN_SHORT' || result.action === 'CLOSE_LONG') {
                signals.push({
                    time: bar.time,
                    type: 'sell',
                    price: bar.close,
                    reason: `[${definition.name}] ${result.reason}`,
                });
            }
        }

        // Apply action to state
        state = applyAction(state, result.action, bar, result.reason);
    }

    return {
        signals,
        actions,
        finalState: state,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates an execution context from current state and signal
 */
export function createContext(
    position: PositionState,
    signal: CombinedSignal,
    rules: ExecutionRules,
    shortEnabled: boolean
): ExecutionContext {
    return {
        currentPosition: position,
        combinedSignal: signal,
        rules,
        shortEnabled,
    };
}

/**
 * Checks if an action is an entry action
 */
export function isEntryAction(action: ExecutionAction): boolean {
    return action === 'OPEN_LONG' || action === 'OPEN_SHORT';
}

/**
 * Checks if an action is an exit action
 */
export function isExitAction(action: ExecutionAction): boolean {
    return action === 'CLOSE_LONG' || action === 'CLOSE_SHORT';
}

/**
 * Gets the direction of an action
 */
export function getActionDirection(action: ExecutionAction): 'long' | 'short' | null {
    if (action === 'OPEN_LONG' || action === 'CLOSE_LONG') return 'long';
    if (action === 'OPEN_SHORT' || action === 'CLOSE_SHORT') return 'short';
    return null;
}
