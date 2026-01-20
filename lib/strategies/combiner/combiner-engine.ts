// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner - Core Engine
// ═══════════════════════════════════════════════════════════════════════════

import type { Signal, OHLCVData, StrategyParams, Time, Strategy } from '../types';
import { strategies } from '../library';
import {
    CombinedSignal,
    CombinationNode,
    CombinedStrategyDefinition,
    LogicOperator,
    ExecutionRules,
    ValidationResult,
    MAX_COMBINATION_DEPTH,
} from './combiner-types';

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Converts a standard Signal type to CombinedSignal
 */
export function normalizeSignalType(signalType: 'buy' | 'sell' | null): CombinedSignal {
    if (signalType === 'buy') return 'BUY';
    if (signalType === 'sell') return 'SELL';
    return 'NO_SIGNAL';
}

/**
 * Creates a time-indexed map of signals for fast lookup
 */
export function createSignalMap(signals: Signal[]): Map<string, CombinedSignal> {
    const map = new Map<string, CombinedSignal>();
    for (const signal of signals) {
        const key = timeToKey(signal.time);
        map.set(key, normalizeSignalType(signal.type));
    }
    return map;
}

/**
 * Converts Time to a string key for map lookup
 */
function timeToKey(time: Time): string {
    if (typeof time === 'number') return time.toString();
    if (typeof time === 'string') return time;
    // BusinessDay format
    return `${time.year}-${time.month}-${time.day}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIC OPERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates AND operator on two signals
 * Returns signal only if both agree on direction
 * 
 * Truth table:
 * BUY AND BUY = BUY
 * SELL AND SELL = SELL
 * BUY AND SELL = NO_SIGNAL (conflict)
 * BUY AND NO_SIGNAL = NO_SIGNAL
 * SELL AND NO_SIGNAL = NO_SIGNAL
 */
function evaluateAnd(a: CombinedSignal, b: CombinedSignal): CombinedSignal {
    if (a === b && a !== 'NO_SIGNAL') return a;
    return 'NO_SIGNAL';
}

/**
 * Evaluates OR operator on two signals
 * Returns signal if either has a signal (non-conflicting)
 * 
 * Truth table:
 * BUY OR BUY = BUY
 * SELL OR SELL = SELL
 * BUY OR SELL = NO_SIGNAL (conflict)
 * BUY OR NO_SIGNAL = BUY
 * SELL OR NO_SIGNAL = SELL
 */
function evaluateOr(a: CombinedSignal, b: CombinedSignal): CombinedSignal {
    if (a === 'NO_SIGNAL') return b;
    if (b === 'NO_SIGNAL') return a;
    if (a === b) return a;
    // Conflicting signals
    return 'NO_SIGNAL';
}

/**
 * Evaluates NOT operator - inverts the signal
 * 
 * NOT BUY = SELL
 * NOT SELL = BUY
 * NOT NO_SIGNAL = NO_SIGNAL
 */
function evaluateNot(signal: CombinedSignal): CombinedSignal {
    if (signal === 'BUY') return 'SELL';
    if (signal === 'SELL') return 'BUY';
    return 'NO_SIGNAL';
}

/**
 * Evaluates XOR operator - exclusive or
 * Returns signal only if exactly one has a signal
 * 
 * BUY XOR NO_SIGNAL = BUY
 * SELL XOR NO_SIGNAL = SELL
 * BUY XOR BUY = NO_SIGNAL
 * SELL XOR SELL = NO_SIGNAL
 * BUY XOR SELL = NO_SIGNAL (both have signals)
 */
function evaluateXor(a: CombinedSignal, b: CombinedSignal): CombinedSignal {
    const aHasSignal = a !== 'NO_SIGNAL';
    const bHasSignal = b !== 'NO_SIGNAL';

    // XOR: exactly one must have a signal
    if (aHasSignal && !bHasSignal) return a;
    if (!aHasSignal && bHasSignal) return b;
    return 'NO_SIGNAL';
}

/**
 * Evaluates a logic operator on an array of signals
 */
export function evaluateOperator(
    operator: LogicOperator,
    signals: CombinedSignal[]
): CombinedSignal {
    if (signals.length === 0) return 'NO_SIGNAL';

    if (operator === 'NOT') {
        // NOT only applies to the first operand
        return evaluateNot(signals[0]);
    }

    if (signals.length === 1) return signals[0];

    // Reduce signals using the operator
    let result = signals[0];
    for (let i = 1; i < signals.length; i++) {
        switch (operator) {
            case 'AND':
                result = evaluateAnd(result, signals[i]);
                break;
            case 'OR':
                result = evaluateOr(result, signals[i]);
                break;
            case 'XOR':
                result = evaluateXor(result, signals[i]);
                break;
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// NODE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates a combination node at a specific time point
 * Recursively evaluates operator nodes and their operands
 */
export function evaluateNode(
    node: CombinationNode,
    timeKey: string,
    signalMaps: Map<string, Map<string, CombinedSignal>>
): CombinedSignal {
    if (node.type === 'strategy') {
        // Leaf node - look up the signal for this strategy at this time
        if (!node.strategyRef) return 'NO_SIGNAL';
        // Use strategyRef.id (string) as the key to find the signal map
        const strategyMap = signalMaps.get(node.strategyRef.id);
        if (!strategyMap) return 'NO_SIGNAL';
        return strategyMap.get(timeKey) ?? 'NO_SIGNAL';
    }

    if (node.type === 'operator') {
        // Operator node - evaluate all operands and apply operator
        if (!node.operator || !node.operands || node.operands.length === 0) {
            return 'NO_SIGNAL';
        }

        const operandSignals = node.operands.map(operand =>
            evaluateNode(operand, timeKey, signalMaps)
        );

        return evaluateOperator(node.operator, operandSignals);
    }

    return 'NO_SIGNAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves conflicts between strategy signals based on resolution mode
 */
export function resolveConflict(
    signals: Map<any, CombinedSignal>,
    rules: ExecutionRules
): CombinedSignal {
    const signalValues = Array.from(signals.values());
    const nonNullSignals = signalValues.filter(s => s !== 'NO_SIGNAL');

    if (nonNullSignals.length === 0) return 'NO_SIGNAL';

    switch (rules.conflictResolution) {
        case 'all_agree':
            return resolveAllAgree(nonNullSignals);

        case 'all_disagree':
            return resolveAllDisagree(nonNullSignals);

        case 'subset_agree':
            return resolveSubsetAgree(signals, rules.subsetStrategyIds ?? []);

        case 'follow_primary':
            return resolveFollowPrimary(signals, rules.primaryStrategyId);

        default:
            return 'NO_SIGNAL';
    }
}

/**
 * all_agree: Returns signal only if ALL strategies have the same signal
 */
function resolveAllAgree(signals: CombinedSignal[]): CombinedSignal {
    if (signals.length === 0) return 'NO_SIGNAL';
    const first = signals[0];
    const allSame = signals.every(s => s === first);
    return allSame ? first : 'NO_SIGNAL';
}

/**
 * all_disagree: Returns signal only if ALL strategies disagree (contrarian)
 * This is unusual but can be used for contrarian combinations
 */
function resolveAllDisagree(signals: CombinedSignal[]): CombinedSignal {
    const hasBuy = signals.some(s => s === 'BUY');
    const hasSell = signals.some(s => s === 'SELL');

    // If all disagree, we look for majority or return NO_SIGNAL
    if (hasBuy && hasSell) {
        const buyCount = signals.filter(s => s === 'BUY').length;
        const sellCount = signals.filter(s => s === 'SELL').length;

        // Return the minority signal (contrarian)
        if (buyCount < sellCount) return 'BUY';
        if (sellCount < buyCount) return 'SELL';
        return 'NO_SIGNAL'; // Equal - no clear contrarian signal
    }

    return 'NO_SIGNAL';
}

/**
 * subset_agree: Returns signal only if the specified subset all agree
 */
function resolveSubsetAgree(
    signals: Map<any, CombinedSignal>,
    subsetIds: string[]
): CombinedSignal {
    if (subsetIds.length === 0) return 'NO_SIGNAL';

    const subsetSignals: CombinedSignal[] = [];
    for (const [meta, signal] of signals.entries()) {
        if (subsetIds.includes(meta.id) && signal !== 'NO_SIGNAL') {
            subsetSignals.push(signal);
        }
    }

    return resolveAllAgree(subsetSignals);
}

/**
 * follow_primary: Always follow the designated primary strategy
 */
function resolveFollowPrimary(
    signals: Map<any, CombinedSignal>,
    primaryId: string | undefined
): CombinedSignal {
    if (!primaryId) return 'NO_SIGNAL';
    for (const [meta, signal] of signals.entries()) {
        if (meta.id === primaryId) return signal;
    }
    return 'NO_SIGNAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculates the depth of a combination node tree
 */
export function calculateDepth(node: CombinationNode, currentDepth: number = 0): number {
    if (node.type === 'strategy') {
        // Check if this strategy is itself a combined strategy
        if (node.strategyRef?.isCombined) {
            return currentDepth + 1;
        }
        return currentDepth;
    }

    if (node.type === 'operator' && node.operands) {
        let maxChildDepth = currentDepth;
        for (const operand of node.operands) {
            const childDepth = calculateDepth(operand, currentDepth);
            maxChildDepth = Math.max(maxChildDepth, childDepth);
        }
        return maxChildDepth;
    }

    return currentDepth;
}

/**
 * Validates that the combination depth does not exceed MAX_COMBINATION_DEPTH
 */
export function validateDepth(node: CombinationNode): boolean {
    return calculateDepth(node) <= MAX_COMBINATION_DEPTH;
}

/**
 * Collects all strategy IDs referenced in a node tree
 */
export function collectStrategyIds(node: CombinationNode): Set<string> {
    const ids = new Set<string>();

    if (node.type === 'strategy' && node.strategyRef) {
        ids.add(node.strategyRef.strategyId);
    }

    if (node.type === 'operator' && node.operands) {
        for (const operand of node.operands) {
            const childIds = collectStrategyIds(operand);
            childIds.forEach(id => ids.add(id));
        }
    }

    return ids;
}

/**
 * Detects self-referencing combinations
 * A combined strategy cannot reference itself
 */
export function detectSelfReference(
    definition: CombinedStrategyDefinition
): boolean {
    const referencedIds = collectStrategyIds(definition.executionRules.openCondition);

    if (definition.executionRules.closeCondition) {
        const closeIds = collectStrategyIds(definition.executionRules.closeCondition);
        closeIds.forEach(id => referencedIds.add(id));
    }

    if (definition.shortHandling.longLogic) {
        const longIds = collectStrategyIds(definition.shortHandling.longLogic);
        longIds.forEach(id => referencedIds.add(id));
    }

    if (definition.shortHandling.shortLogic) {
        const shortIds = collectStrategyIds(definition.shortHandling.shortLogic);
        shortIds.forEach(id => referencedIds.add(id));
    }

    // Check if any referenced ID matches this definition's ID
    return referencedIds.has(definition.id);
}

/**
 * Validates a combined strategy definition
 */
export function validateDefinition(definition: CombinedStrategyDefinition): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for self-reference
    if (detectSelfReference(definition)) {
        errors.push('Combined strategy cannot reference itself');
    }

    // Check depth
    if (!validateDepth(definition.executionRules.openCondition)) {
        errors.push(`Combination depth exceeds maximum of ${MAX_COMBINATION_DEPTH}`);
    }

    // Check that at least 2 strategies are used
    if (definition.inputStrategies.length < 2) {
        errors.push('Combined strategy must use at least 2 input strategies');
    }

    // Check that all referenced strategies exist
    const allIds = collectStrategyIds(definition.executionRules.openCondition);
    for (const id of allIds) {
        if (!strategies[id]) {
            errors.push(`Referenced strategy not found: ${id}`);
        }
    }

    // Check conflict resolution configuration
    if (definition.executionRules.conflictResolution === 'follow_primary') {
        if (!definition.executionRules.primaryStrategyId) {
            errors.push('Primary strategy ID required for follow_primary resolution');
        }
    }

    if (definition.executionRules.conflictResolution === 'subset_agree') {
        if (!definition.executionRules.subsetStrategyIds?.length) {
            errors.push('Subset strategy IDs required for subset_agree resolution');
        }
    }

    // Warnings
    if (definition.shortHandling.enabled && !definition.shortHandling.shortLogic) {
        warnings.push('Short handling enabled but no short logic defined - will use inverted open condition');
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMBINER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Executes all input strategies and collects their signals
 */
function executeInputStrategies(
    definition: CombinedStrategyDefinition,
    data: OHLCVData[]
): Map<string, Map<string, CombinedSignal>> {
    const signalMaps = new Map<string, Map<string, CombinedSignal>>();

    for (const meta of definition.inputStrategies) {
        const strategy = strategies[meta.strategyId];
        if (!strategy) continue;

        // Use provided params or defaults
        const params: StrategyParams = meta.params ?? strategy.defaultParams;
        const signals = strategy.execute(data, params);
        const signalMap = createSignalMap(signals);
        // Use meta.id (string) as key for consistent lookup
        signalMaps.set(meta.id, signalMap);
    }

    return signalMaps;
}

/**
 * Main entry point for combining strategies
 * Executes all input strategies and combines their signals according to the definition
 */
export function combineStrategies(
    definition: CombinedStrategyDefinition,
    data: OHLCVData[]
): Signal[] {
    // Validate the definition first
    const validation = validateDefinition(definition);
    if (!validation.valid) {
        console.error('Invalid combined strategy definition:', validation.errors);
        return [];
    }

    // Execute all input strategies
    const signalMaps = executeInputStrategies(definition, data);

    // Generate combined signals for each bar
    const combinedSignals: Signal[] = [];

    for (let i = 0; i < data.length; i++) {
        const bar = data[i];
        const key = timeToKey(bar.time);

        // Evaluate the open condition
        let signal = evaluateNode(
            definition.executionRules.openCondition,
            key,
            signalMaps
        );

        // Handle short logic if enabled
        if (definition.shortHandling.enabled) {
            const longSignal = definition.shortHandling.longLogic
                ? evaluateNode(definition.shortHandling.longLogic, key, signalMaps)
                : signal;

            const shortSignal = definition.shortHandling.shortLogic
                ? evaluateNode(definition.shortHandling.shortLogic, key, signalMaps)
                : evaluateNot(signal);

            // Prioritize long over short if both fire
            if (longSignal === 'BUY') {
                signal = 'BUY';
            } else if (shortSignal === 'SELL') {
                signal = 'SELL';
            } else {
                signal = 'NO_SIGNAL';
            }
        }

        // Convert to standard Signal format
        if (signal !== 'NO_SIGNAL') {
            combinedSignals.push({
                time: bar.time,
                type: signal === 'BUY' ? 'buy' : 'sell',
                price: bar.close,
                reason: `Combined: ${definition.name}`,
            });
        }
    }

    return combinedSignals;
}

import { executeStrategy } from './combiner-executor';

/**
 * Converts a CombinedStrategyDefinition into a standard Strategy object
 * that can be used with the existing backtesting infrastructure
 */
export function toExecutableStrategy(definition: CombinedStrategyDefinition): Strategy {
    return {
        name: definition.name,
        description: definition.description ?? `Combined strategy: ${definition.inputStrategies.map(s => s.strategyId).join(' + ')}`,
        defaultParams: {},  // Combined strategies have no additional params
        paramLabels: {},
        execute: (data: OHLCVData[], _params: StrategyParams): Signal[] => {
            const result = executeStrategy({ definition }, data);
            return result.signals;
        },
        metadata: {
            isCombined: true,
            direction: definition.shortHandling.enabled ? 'both' : 'long',
        },
    };
}
