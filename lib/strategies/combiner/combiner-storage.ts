// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner - Storage & Persistence
// ═══════════════════════════════════════════════════════════════════════════
//
// This module handles saving, loading, and managing combined strategy
// definitions in localStorage. It also provides utilities to convert
// combined strategies into executable Strategy objects.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import {
    CombinedStrategyDefinition,
    CombinationNode,
    StrategyMetadata,
    ValidationResult,
} from './combiner-types';
import { validateDefinition } from './combiner-engine';
import { executeStrategy } from './combiner-executor';

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'strategy_combiner_definitions';
const STORAGE_VERSION = 1;

interface StorageData {
    version: number;
    definitions: CombinedStrategyDefinition[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serializes a combined strategy definition to JSON string
 */
export function serializeDefinition(definition: CombinedStrategyDefinition): string {
    return JSON.stringify(definition, null, 2);
}

/**
 * Deserializes a JSON string to a combined strategy definition
 * Returns null if parsing fails
 */
export function deserializeDefinition(json: string): CombinedStrategyDefinition | null {
    try {
        const parsed = JSON.parse(json);

        // Validate required fields
        if (!parsed.id || !parsed.name || !parsed.inputStrategies || !parsed.executionRules) {
            console.error('Invalid combined strategy definition: missing required fields');
            return null;
        }

        // Ensure all arrays exist
        if (!Array.isArray(parsed.inputStrategies)) {
            parsed.inputStrategies = [];
        }

        // Set defaults for optional fields
        if (!parsed.shortHandling) {
            parsed.shortHandling = { enabled: false };
        }

        if (typeof parsed.combinationDepth !== 'number') {
            parsed.combinationDepth = calculateCombinationDepth(parsed);
        }

        if (!parsed.createdAt) {
            parsed.createdAt = Date.now();
        }

        return parsed as CombinedStrategyDefinition;
    } catch (e) {
        console.error('Failed to deserialize combined strategy definition:', e);
        return null;
    }
}

/**
 * Calculates the combination depth from a definition
 */
function calculateCombinationDepth(definition: CombinedStrategyDefinition): number {
    let maxDepth = 0;

    function countDepth(node: CombinationNode, depth: number): void {
        if (node.type === 'strategy' && node.strategyRef?.isCombined) {
            maxDepth = Math.max(maxDepth, depth + 1);
        }
        if (node.type === 'operator' && node.operands) {
            for (const operand of node.operands) {
                countDepth(operand, depth);
            }
        }
    }

    countDepth(definition.executionRules.openCondition, 0);
    if (definition.executionRules.closeCondition) {
        countDepth(definition.executionRules.closeCondition, 0);
    }

    return maxDepth;
}

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets all stored data from localStorage
 */
function getStorageData(): StorageData {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { version: STORAGE_VERSION, definitions: [] };
        }

        const data = JSON.parse(raw) as StorageData;

        // Handle version migrations if needed
        if (data.version !== STORAGE_VERSION) {
            return migrateStorageData(data);
        }

        return data;
    } catch (e) {
        console.error('Failed to read combined strategies from storage:', e);
        return { version: STORAGE_VERSION, definitions: [] };
    }
}

/**
 * Saves storage data to localStorage
 */
function setStorageData(data: StorageData): boolean {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return true;
    } catch (e) {
        console.error('Failed to save combined strategies to storage:', e);
        return false;
    }
}

/**
 * Migrates storage data from older versions
 */
function migrateStorageData(data: StorageData): StorageData {
    // Currently no migrations needed, just update version
    return {
        version: STORAGE_VERSION,
        definitions: data.definitions || [],
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Saves a combined strategy definition
 * Validates the definition before saving
 */
export function saveCombinedStrategy(definition: CombinedStrategyDefinition): ValidationResult & { saved: boolean } {
    // Validate first
    const validation = validateDefinition(definition);

    if (!validation.valid) {
        return { ...validation, saved: false };
    }

    // Update timestamp
    definition.updatedAt = Date.now();

    // Get existing data
    const data = getStorageData();

    // Check if this ID already exists (update) or is new (insert)
    const existingIndex = data.definitions.findIndex(d => d.id === definition.id);

    if (existingIndex >= 0) {
        // Update existing
        data.definitions[existingIndex] = definition;
    } else {
        // Insert new
        data.definitions.push(definition);
    }

    // Save
    const saved = setStorageData(data);

    return { ...validation, saved };
}

/**
 * Loads a combined strategy definition by ID
 */
export function loadCombinedStrategy(id: string): CombinedStrategyDefinition | null {
    const data = getStorageData();
    return data.definitions.find(d => d.id === id) ?? null;
}

/**
 * Lists all saved combined strategy definitions
 */
export function listCombinedStrategies(): CombinedStrategyDefinition[] {
    const data = getStorageData();
    return data.definitions;
}

/**
 * Deletes a combined strategy definition by ID
 */
export function deleteCombinedStrategy(id: string): boolean {
    const data = getStorageData();
    const initialLength = data.definitions.length;

    data.definitions = data.definitions.filter(d => d.id !== id);

    if (data.definitions.length === initialLength) {
        // Nothing was deleted
        return false;
    }

    return setStorageData(data);
}

/**
 * Checks if a combined strategy with the given ID exists
 */
export function combinedStrategyExists(id: string): boolean {
    const data = getStorageData();
    return data.definitions.some(d => d.id === id);
}

/**
 * Generates a unique ID for a new combined strategy
 */
export function generateStrategyId(baseName: string): string {
    const sanitized = baseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

    const timestamp = Date.now().toString(36);
    return `combined_${sanitized}_${timestamp}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY CONVERSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Converts a CombinedStrategyDefinition into a standard Strategy object
 * that can be used with the existing backtesting infrastructure
 */
export function toExecutableStrategy(definition: CombinedStrategyDefinition): Strategy {
    return {
        name: definition.name,
        description: definition.description ??
            `Combined: ${definition.inputStrategies.map(s => s.strategyId).join(' + ')}`,
        defaultParams: {},
        paramLabels: {},
        execute: (data: OHLCVData[], _params: StrategyParams): Signal[] => {
            // Use the executor for stateful execution
            const result = executeStrategy({ definition }, data);
            return result.signals;
        },
        metadata: {
            isCombined: true,
            direction: definition.shortHandling.enabled ? 'both' : 'long',
        },
    };
}

/**
 * Converts all saved combined strategies to executable Strategy objects
 */
export function loadAllAsStrategies(): Record<string, Strategy> {
    const definitions = listCombinedStrategies();
    const strategies: Record<string, Strategy> = {};

    for (const def of definitions) {
        strategies[def.id] = toExecutableStrategy(def);
    }

    return strategies;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new empty combined strategy definition
 */
export function createEmptyDefinition(name: string): CombinedStrategyDefinition {
    return {
        id: generateStrategyId(name),
        name,
        description: '',
        inputStrategies: [],
        executionRules: {
            openCondition: { type: 'operator', operator: 'AND', operands: [] },
            conflictResolution: 'all_agree',
        },
        shortHandling: {
            enabled: false,
        },
        combinationDepth: 0,
        createdAt: Date.now(),
    };
}

/**
 * Creates a strategy metadata object
 */
export function createStrategyMetadata(
    strategyId: string,
    role: StrategyMetadata['role'] = 'entry',
    direction: StrategyMetadata['direction'] = 'both'
): StrategyMetadata {
    return {
        id: Math.random().toString(36).substring(2, 9),
        strategyId,
        role,
        direction,
    };
}

/**
 * Creates a strategy reference node
 */
export function createStrategyNode(metadata: StrategyMetadata): CombinationNode {
    return {
        type: 'strategy',
        strategyRef: metadata,
    };
}

/**
 * Creates an operator node
 */
export function createOperatorNode(
    operator: CombinationNode['operator'],
    operands: CombinationNode[]
): CombinationNode {
    return {
        type: 'operator',
        operator,
        operands,
    };
}

/**
 * Creates a simple AND combination of multiple strategies
 */
export function createAndCombination(
    name: string,
    strategyIds: string[],
    options: {
        description?: string;
        shortEnabled?: boolean;
    } = {}
): CombinedStrategyDefinition {
    const inputStrategies = strategyIds.map(id => createStrategyMetadata(id));
    const operands = inputStrategies.map(meta => createStrategyNode(meta));

    return {
        id: generateStrategyId(name),
        name,
        description: options.description ?? `AND combination: ${strategyIds.join(' AND ')}`,
        inputStrategies,
        executionRules: {
            openCondition: createOperatorNode('AND', operands),
            conflictResolution: 'all_agree',
        },
        shortHandling: {
            enabled: options.shortEnabled ?? false,
        },
        combinationDepth: 0,
        createdAt: Date.now(),
    };
}

/**
 * Creates a simple OR combination of multiple strategies
 */
export function createOrCombination(
    name: string,
    strategyIds: string[],
    options: {
        description?: string;
        shortEnabled?: boolean;
    } = {}
): CombinedStrategyDefinition {
    const inputStrategies = strategyIds.map(id => createStrategyMetadata(id));
    const operands = inputStrategies.map(meta => createStrategyNode(meta));

    return {
        id: generateStrategyId(name),
        name,
        description: options.description ?? `OR combination: ${strategyIds.join(' OR ')}`,
        inputStrategies,
        executionRules: {
            openCondition: createOperatorNode('OR', operands),
            conflictResolution: 'all_agree',
        },
        shortHandling: {
            enabled: options.shortEnabled ?? false,
        },
        combinationDepth: 0,
        createdAt: Date.now(),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT / EXPORT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exports a combined strategy definition to a JSON file download
 */
export function exportToFile(definition: CombinedStrategyDefinition): void {
    const json = serializeDefinition(definition);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${definition.id}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
}

/**
 * Imports a combined strategy definition from a JSON file
 * Returns a promise that resolves to the definition or null on error
 */
export function importFromFile(file: File): Promise<CombinedStrategyDefinition | null> {
    return new Promise((resolve) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const json = e.target?.result as string;
                const definition = deserializeDefinition(json);
                resolve(definition);
            } catch {
                resolve(null);
            }
        };

        reader.onerror = () => {
            resolve(null);
        };

        reader.readAsText(file);
    });
}

/**
 * Exports all combined strategies to a single JSON file
 */
export function exportAllToFile(): void {
    const data = getStorageData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `combined_strategies_backup_${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
}

/**
 * Imports combined strategies from a backup file
 * Returns the number of strategies imported
 */
export function importAllFromFile(file: File): Promise<number> {
    return new Promise((resolve) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const json = e.target?.result as string;
                const data = JSON.parse(json) as StorageData;

                if (!data.definitions || !Array.isArray(data.definitions)) {
                    resolve(0);
                    return;
                }

                let imported = 0;
                for (const def of data.definitions) {
                    const result = saveCombinedStrategy(def);
                    if (result.saved) {
                        imported++;
                    }
                }

                resolve(imported);
            } catch {
                resolve(0);
            }
        };

        reader.onerror = () => {
            resolve(0);
        };

        reader.readAsText(file);
    });
}
