/// <reference types="vite/client" />

/**
 * Strategy Registry with Hot Module Replacement (HMR) Support
 * 
 * This module provides a dynamic strategy registry that supports:
 * - Runtime registration/unregistration of strategies
 * - Hot Module Replacement for instant strategy updates
 * - Event-based notifications for UI updates
 * - Type-safe strategy management
 */

import type { Strategy, OHLCVData, Signal, StrategyParams } from "./lib/strategies/index";
export type { Strategy, OHLCVData, Signal, StrategyParams };


// ============================================================================
// Types
// ============================================================================

export interface StrategyRegistryEvent {
    type: 'register' | 'unregister' | 'update' | 'clear';
    strategyKey?: string;
    strategy?: Strategy;
}

export type StrategyRegistryListener = (event: StrategyRegistryEvent) => void;

export interface StrategyRegistry {
    /** Register a new strategy */
    register(key: string, strategy: Strategy): void;

    /** Unregister a strategy by key */
    unregister(key: string): boolean;

    /** Get a strategy by key */
    get(key: string): Strategy | undefined;

    /** Check if a strategy exists */
    has(key: string): boolean;

    /** Get all strategy keys */
    keys(): string[];

    /** Get all strategies as a record */
    getAll(): Record<string, Strategy>;

    /** Clear all strategies */
    clear(): void;

    /** Subscribe to registry changes */
    subscribe(listener: StrategyRegistryListener): () => void;

    /** Get the count of registered strategies */
    count(): number;
}

// ============================================================================
// Strategy Registry Implementation
// ============================================================================

class StrategyRegistryImpl implements StrategyRegistry {
    private strategies: Map<string, Strategy> = new Map();
    private listeners: Set<StrategyRegistryListener> = new Set();

    private emit(event: StrategyRegistryEvent): void {
        this.listeners.forEach(listener => {
            try {
                listener(event);
            } catch (e) {
                console.error('[StrategyRegistry] Error in listener:', e);
            }
        });
    }

    register(key: string, strategy: Strategy): void {
        const isUpdate = this.strategies.has(key);
        this.strategies.set(key, strategy);

        console.log(`[StrategyRegistry] ${isUpdate ? 'Updated' : 'Registered'}: ${key} - "${strategy.name}"`);

        this.emit({
            type: isUpdate ? 'update' : 'register',
            strategyKey: key,
            strategy
        });
    }

    unregister(key: string): boolean {
        const existed = this.strategies.delete(key);

        if (existed) {
            console.log(`[StrategyRegistry] Unregistered: ${key}`);
            this.emit({ type: 'unregister', strategyKey: key });
        }

        return existed;
    }

    get(key: string): Strategy | undefined {
        return this.strategies.get(key);
    }

    has(key: string): boolean {
        return this.strategies.has(key);
    }

    keys(): string[] {
        return Array.from(this.strategies.keys());
    }

    getAll(): Record<string, Strategy> {
        const result: Record<string, Strategy> = {};
        this.strategies.forEach((strategy, key) => {
            result[key] = strategy;
        });
        return result;
    }

    clear(): void {
        this.strategies.clear();
        console.log('[StrategyRegistry] Cleared all strategies');
        this.emit({ type: 'clear' });
    }

    subscribe(listener: StrategyRegistryListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    count(): number {
        return this.strategies.size;
    }
}

// ============================================================================
// Global Registry Instance
// ============================================================================

// Create a singleton registry instance
export const strategyRegistry: StrategyRegistry = new StrategyRegistryImpl();

// ============================================================================
// Built-in Strategy Loader
// ============================================================================

/**
 * Load built-in strategies from the main strategies module
 */
export async function loadBuiltInStrategies(): Promise<void> {
    // Import strategies module dynamically to support HMR
    const { strategies: builtInStrategies } = await import("./lib/strategies/index");

    Object.entries(builtInStrategies).forEach(([key, strategy]) => {
        strategyRegistry.register(key, strategy);
    });

    console.log(`[StrategyRegistry] Loaded ${Object.keys(builtInStrategies).length} built-in strategies`);
}

// ============================================================================
// HMR Support
// ============================================================================

// Check if HMR is available (Vite)
if (import.meta.hot) {
    // Accept updates to the strategies module
    import.meta.hot.accept("./lib/strategies/index", async (newModule) => {
        if (newModule) {
            console.log('[HMR] Strategies module updated, reloading...');

            // Clear existing strategies and reload
            strategyRegistry.clear();

            Object.entries(newModule.strategies).forEach(([key, strategy]) => {
                strategyRegistry.register(key, strategy as Strategy);
            });

            console.log('[HMR] Strategies reloaded successfully');
        }
    });

    // Also accept updates to this file itself
    import.meta.hot.accept();
}

// ============================================================================
// Custom Strategy Builder (for runtime strategy creation)
// ============================================================================

export interface CustomStrategyConfig {
    key: string;
    name: string;
    description: string;
    defaultParams: StrategyParams;
    paramLabels: Record<string, string>;
    executeCode: string; // JavaScript code as string
}

/**
 * Create and register a custom strategy from configuration
 * This allows creating strategies at runtime (e.g., from user input)
 */
export function createCustomStrategy(config: CustomStrategyConfig): boolean {
    try {
        // Create the execute function from code string
        // eslint-disable-next-line no-new-func
        const executeFunction = new Function(
            'data',
            'params',
            'indicators',
            config.executeCode
        ) as (data: OHLCVData[], params: StrategyParams, indicators: typeof indicatorHelpers) => Signal[];

        const strategy: Strategy = {
            name: config.name,
            description: config.description,
            defaultParams: config.defaultParams,
            paramLabels: config.paramLabels,
            execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
                return executeFunction(data, params, indicatorHelpers);
            }
        };

        strategyRegistry.register(config.key, strategy);
        return true;
    } catch (error) {
        console.error('[StrategyRegistry] Failed to create custom strategy:', error);
        return false;
    }
}

// ============================================================================
// Indicator Helpers (exposed to custom strategies)
// ============================================================================

import * as indicators from "./lib/strategies/indicators";

export const indicatorHelpers = indicators;


// ============================================================================
// Local Storage Persistence
// ============================================================================

const CUSTOM_STRATEGIES_KEY = 'playground_custom_strategies';

export function saveCustomStrategiesToStorage(configs: CustomStrategyConfig[]): void {
    try {
        localStorage.setItem(CUSTOM_STRATEGIES_KEY, JSON.stringify(configs));
        console.log(`[StrategyRegistry] Saved ${configs.length} custom strategies to localStorage`);
    } catch (e) {
        console.error('[StrategyRegistry] Failed to save custom strategies:', e);
    }
}

export function loadCustomStrategiesFromStorage(): CustomStrategyConfig[] {
    try {
        const data = localStorage.getItem(CUSTOM_STRATEGIES_KEY);
        if (data) {
            const configs = JSON.parse(data) as CustomStrategyConfig[];
            console.log(`[StrategyRegistry] Loaded ${configs.length} custom strategies from localStorage`);
            return configs;
        }
    } catch (e) {
        console.error('[StrategyRegistry] Failed to load custom strategies:', e);
    }
    return [];
}

/**
 * Load custom strategies from localStorage and register them
 */
export function restoreCustomStrategies(): void {
    const configs = loadCustomStrategiesFromStorage();
    configs.forEach(config => {
        createCustomStrategy(config);
    });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get a formatted list of all strategies for display
 */
export function getStrategyList(): Array<{ key: string; name: string; description: string }> {
    return strategyRegistry.keys().map(key => {
        const strategy = strategyRegistry.get(key)!;
        return {
            key,
            name: strategy.name,
            description: strategy.description
        };
    });
}

/**
 * Validate a strategy key
 */
export function isValidStrategyKey(key: string): boolean {
    return /^[a-z][a-z0-9_]*$/.test(key);
}

// Export for debugging in browser console
if (typeof window !== 'undefined') {
    (window as any).__strategyRegistry = strategyRegistry;
    (window as any).__indicatorHelpers = indicatorHelpers;
    (window as any).__createCustomStrategy = createCustomStrategy;
}
