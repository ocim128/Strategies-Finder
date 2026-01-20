// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner Module - Public API
// ═══════════════════════════════════════════════════════════════════════════

// Re-export all types
export {
    // Signal types
    type CombinedSignal,

    // Strategy metadata
    type StrategyRole,
    type StrategyDirection,
    type StrategyMetadata,

    // Logic operators
    type LogicOperator,
    type CombinationNode,

    // Execution
    type ConflictResolution,
    type ExecutionRules,
    type ShortHandling,
    type CombinedStrategyDefinition,
    type ExecutionContext,
    type ExecutionResult,

    // Validation
    type ValidationResult,
    MAX_COMBINATION_DEPTH,
} from './combiner-types';

// Re-export engine functions
export {
    // Signal normalization
    normalizeSignalType,
    createSignalMap,

    // Logic operators
    evaluateOperator,
    evaluateNode,

    // Conflict resolution
    resolveConflict,

    // Validation
    validateDepth,
    calculateDepth,
    collectStrategyIds,
    detectSelfReference,
    validateDefinition,

    // Main combiner
    combineStrategies,
    toExecutableStrategy,
} from './combiner-engine';

// Re-export executor types and functions
export {
    // Types
    type PositionState,
    type ExecutorState,
    type ExecutionAction,
    type DirectionSignals,
    type ExecutorConfig,
    type ExecutorOutput,

    // State management
    createInitialState,
    applyAction,

    // Action determination
    determineAction,
    evaluateCloseCondition,

    // Short handling
    evaluateDirectionSignals,
    resolveDirectionConflict,

    // Main executor
    executeStrategy,

    // Helpers
    createContext,
    isEntryAction,
    isExitAction,
    getActionDirection,
} from './combiner-executor';

// Re-export storage functions
export {
    // Serialization
    serializeDefinition,
    deserializeDefinition,

    // CRUD operations
    saveCombinedStrategy,
    loadCombinedStrategy,
    listCombinedStrategies,
    deleteCombinedStrategy,
    combinedStrategyExists,
    generateStrategyId,

    // Strategy conversion
    toExecutableStrategy as toStrategy,
    loadAllAsStrategies,

    // Builder helpers
    createEmptyDefinition,
    createStrategyMetadata,
    createStrategyNode,
    createOperatorNode,
    createAndCombination,
    createOrCombination,

    // Import/Export
    exportToFile,
    importFromFile,
    exportAllToFile,
    importAllFromFile,
} from './combiner-storage';
