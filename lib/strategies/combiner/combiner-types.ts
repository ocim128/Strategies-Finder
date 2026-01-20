// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner - Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalized signal output from combined strategies
 * - BUY: Open long position (or close short)
 * - SELL: Close long position (or open short when enabled)
 * - NO_SIGNAL: No action required
 */
export type CombinedSignal = 'BUY' | 'SELL' | 'NO_SIGNAL';

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY METADATA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Role that a strategy plays in the combination
 * - entry: Generates primary entry signals
 * - filter: Filters out bad signals from entry strategies
 * - exit: Determines when to close positions
 * - regime: Market regime detection (trending/ranging)
 */
export type StrategyRole = 'entry' | 'filter' | 'exit' | 'regime';

/**
 * Trading direction capability of a strategy
 * - long: Only generates long signals
 * - short: Only generates short signals
 * - both: Can generate both long and short signals
 */
export type StrategyDirection = 'long' | 'short' | 'both';

/**
 * Metadata for a strategy used in combinations
 */
export interface StrategyMetadata {
    /** Reference to the saved strategy identifier */
    strategyId: string;
    /** How this strategy is used in the combination */
    role: StrategyRole;
    /** Trading direction capability */
    direction: StrategyDirection;
    /** Timeframe the strategy operates on (e.g., '1h', '4h', '1d') */
    timeframe?: string;
    /** True if this is already a combined strategy */
    isCombined?: boolean;
    /** Parameters to use for this strategy (if different from defaults) */
    params?: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIC OPERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Logical operators for combining strategy signals
 * - AND: All operands must agree (BUY AND BUY = BUY)
 * - OR: Any operand can trigger (BUY OR NO_SIGNAL = BUY)
 * - NOT: Inverts the signal (NOT BUY = SELL)
 * - XOR: Exclusive or - only one operand must be true
 */
export type LogicOperator = 'AND' | 'OR' | 'NOT' | 'XOR';

/**
 * Node in the combination expression tree
 * Can be either a strategy reference or a logical operator with operands
 */
export interface CombinationNode {
    /** Type of node */
    type: 'strategy' | 'operator';
    /** Strategy reference (when type === 'strategy') */
    strategyRef?: StrategyMetadata;
    /** Logical operator (when type === 'operator') */
    operator?: LogicOperator;
    /** Child nodes for operator (when type === 'operator') */
    operands?: CombinationNode[];
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION RULES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Conflict resolution strategies when signals disagree
 * - all_agree: Trade only when all strategies agree on direction
 * - all_disagree: Trade only when all strategies disagree (contrarian)
 * - subset_agree: Trade when a specific subset of strategies agrees
 * - follow_primary: Always follow the designated primary strategy
 */
export type ConflictResolution =
    | 'all_agree'
    | 'all_disagree'
    | 'subset_agree'
    | 'follow_primary';

/**
 * Rules for trade execution based on combined signals
 */
export interface ExecutionRules {
    /** Expression tree for OPEN condition - trade opens when this evaluates to BUY/SELL */
    openCondition: CombinationNode;
    /** Optional explicit CLOSE condition - if not set, opposite signal closes */
    closeCondition?: CombinationNode;
    /** How to handle conflicting signals between strategies */
    conflictResolution: ConflictResolution;
    /** Strategy to follow when conflictResolution = 'follow_primary' */
    primaryStrategyId?: string;
    /** Strategies that must agree when conflictResolution = 'subset_agree' */
    subsetStrategyIds?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SHORT HANDLING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for short position handling
 * When enabled, allows independent logic for long and short entries
 */
export interface ShortHandling {
    /** Master toggle for short positions */
    enabled: boolean;
    /** Independent logic for long entries (optional, uses openCondition if not set) */
    longLogic?: CombinationNode;
    /** Independent logic for short entries (only used when enabled = true) */
    shortLogic?: CombinationNode;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED STRATEGY DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete definition of a combined strategy
 * This is the main structure that gets saved and loaded
 */
export interface CombinedStrategyDefinition {
    /** Unique identifier for this combined strategy */
    id: string;
    /** User-friendly display name */
    name: string;
    /** Optional description of the strategy */
    description?: string;
    /** All strategies used in this combination */
    inputStrategies: StrategyMetadata[];
    /** Rules for trade execution */
    executionRules: ExecutionRules;
    /** Short position configuration */
    shortHandling: ShortHandling;
    /** Auto-calculated depth of combination nesting (max 2) */
    combinationDepth: number;
    /** Timestamp when this combination was created */
    createdAt: number;
    /** Timestamp when this combination was last modified */
    updatedAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION CONTEXT & RESULTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Current state during strategy execution
 */
export interface ExecutionContext {
    /** Current position state */
    currentPosition: 'long' | 'short' | 'flat';
    /** The combined signal for the current bar */
    combinedSignal: CombinedSignal;
    /** Execution rules from the strategy definition */
    rules: ExecutionRules;
    /** Whether short positions are enabled */
    shortEnabled: boolean;
}

/**
 * Result of execution decision for a single bar
 */
export interface ExecutionResult {
    /** Action to take */
    action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'DO_NOTHING';
    /** Human-readable reason for the action */
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validation result for a combined strategy definition
 */
export interface ValidationResult {
    /** Whether the definition is valid */
    valid: boolean;
    /** List of validation errors (if any) */
    errors: string[];
    /** List of validation warnings (if any) */
    warnings: string[];
}

/**
 * Maximum allowed combination depth
 * A depth of 2 means a combined strategy can contain other combined strategies,
 * but those nested combined strategies cannot contain more combined strategies
 */
export const MAX_COMBINATION_DEPTH = 2;
