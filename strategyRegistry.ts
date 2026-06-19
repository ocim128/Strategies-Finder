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

import type {
    Strategy,
    OHLCVData,
    Signal,
    StrategyParams,
    StrategyExecutionContext,
} from "./lib/strategies/index";
import { state } from "./lib/state";
import {
    resampleOHLCV,
    type ResampleOptions,
} from "./lib/strategies/resample-utils";
import { readPersistedJson, writePersistedJson } from "./lib/persisted-json";
import {
    getAllBuiltInMeta,
    getBuiltInStrategyKeys,
    getBuiltInStrategyMeta,
    getLoadedBuiltInStrategy,
    isBuiltInKey,
    isBuiltInStrategyLoaded,
    ensureBuiltInStrategyLoaded,
    type BuiltInStrategyMeta,
} from "./lib/strategies/built-in-catalog";
import { toNumericTimeData, mapSignalsFromHigherTimeframe } from "./lib/strategy-timeframe";
export type { Strategy, OHLCVData, Signal, StrategyParams };
export type { BuiltInStrategyMeta };


// ============================================================================
// Types
// ============================================================================

export interface StrategyRegistryEvent {
    type: 'register' | 'unregister' | 'update' | 'clear';
    strategyKey?: string;
    strategy?: Strategy;
}

export type StrategyRegistryListener = (event: StrategyRegistryEvent) => void;
export type StrategyKind = "polymarket-1s" | "cross-symbol" | "standard";

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

const builtInStrategyKeys = new Set<string>();

function logRegistryInfo(message: string): void {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
    if (env?.DEV === true) {
        console.log(message);
    }
}

// ============================================================================
// Strategy Registry Implementation
// ============================================================================

class StrategyRegistryImpl implements StrategyRegistry {
    private strategies: Map<string, Strategy> = new Map();
    private listeners: Set<StrategyRegistryListener> = new Set();
    private readonly wrappedFlag = '__global_timeframe_wrapped__';

    private readGlobalStrategyTfSettings(): { enabled: boolean; minutes: number } {
        const enabled = state.strategyTimeframeEnabled === true;
        const parsedMinutes = Number(state.strategyTimeframeMinutes);
        const minutes = Number.isFinite(parsedMinutes) ? Math.max(1, Math.floor(parsedMinutes)) : 120;
        return { enabled, minutes };
    }

    private wrapStrategyWithGlobalTimeframe(strategy: Strategy): Strategy {
        const maybeWrapped = strategy as Strategy & { [key: string]: unknown };
        if (maybeWrapped[this.wrappedFlag] === true) {
            return strategy;
        }

        const originalExecute = strategy.execute.bind(strategy);
        const wrapped: Strategy = {
            ...strategy,
            execute: (
                data: OHLCVData[],
                params: StrategyParams,
                context?: StrategyExecutionContext
            ): Signal[] => {
                const { enabled, minutes } = this.readGlobalStrategyTfSettings();
                if (!enabled || data.length === 0) {
                    return originalExecute(data, params, context);
                }

                if (context?.crossSymbol) {
                    throw new Error(
                        'Cross-symbol strategies cannot be used with strategy timeframe resampling. ' +
                        'Disable "Strategy Timeframe" before running this strategy.'
                    );
                }

                const numericData = toNumericTimeData(data);
                if (!numericData) {
                    return originalExecute(data, params, context);
                }

                const interval = `${minutes}m`;
                const resampleOptions: ResampleOptions | undefined = undefined;
                const higherData = resampleOHLCV(numericData, interval, resampleOptions);
                if (higherData.length === 0) {
                    return [];
                }

                const higherSignals = originalExecute(higherData, params, context);
                return mapSignalsFromHigherTimeframe(data, numericData, higherData, higherSignals, interval, resampleOptions);
            }
        };

        (wrapped as Strategy & { [key: string]: unknown })[this.wrappedFlag] = true;
        return wrapped;
    }

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
        const wrappedStrategy = this.wrapStrategyWithGlobalTimeframe(strategy);
        this.strategies.set(key, wrappedStrategy);

        logRegistryInfo(`[StrategyRegistry] ${isUpdate ? 'Updated' : 'Registered'}: ${key} - "${strategy.name}"`);

        this.emit({
            type: isUpdate ? 'update' : 'register',
            strategyKey: key,
            strategy: wrappedStrategy
        });
    }

    unregister(key: string): boolean {
        const existed = this.strategies.delete(key);

        if (existed) {
            logRegistryInfo(`[StrategyRegistry] Unregistered: ${key}`);
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
        return Object.fromEntries(this.strategies);
    }

    clear(): void {
        this.strategies.clear();
        logRegistryInfo('[StrategyRegistry] Cleared all strategies');
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
 * Load built-in strategies through per-key dynamic loaders.
 */
export async function loadBuiltInStrategies(keys?: string[]): Promise<void> {
    const keysToLoad = keys && keys.length > 0 ? keys : [...getBuiltInStrategyKeys()];
    let loadedCount = 0;
    for (const key of keysToLoad) {
        if (!isBuiltInKey(key)) continue;
        if (strategyRegistry.has(key)) continue;
        const strategy = isBuiltInStrategyLoaded(key)
            ? getLoadedBuiltInStrategy(key)
            : await ensureBuiltInStrategyLoaded(key);
        if (strategy) {
            builtInStrategyKeys.add(key);
            strategyRegistry.register(key, strategy);
            loadedCount++;
        }
    }
    logRegistryInfo(`[StrategyRegistry] Loaded ${loadedCount} built-in strategies`);
}

export async function loadBuiltInStrategyByKey(key: string): Promise<Strategy | undefined> {
    if (strategyRegistry.has(key)) {
        return strategyRegistry.get(key);
    }
    if (!isBuiltInKey(key)) return undefined;

    const strategy = isBuiltInStrategyLoaded(key)
        ? getLoadedBuiltInStrategy(key)
        : await ensureBuiltInStrategyLoaded(key);
    if (strategy) {
        builtInStrategyKeys.add(key);
        strategyRegistry.register(key, strategy);
    }
    return strategy;
}

export async function ensureStrategyKeysLoaded(keys: Iterable<string>): Promise<void> {
    const seen = new Set<string>();
    for (const key of keys) {
        if (!key || seen.has(key) || strategyRegistry.has(key)) {
            continue;
        }
        seen.add(key);
        await loadBuiltInStrategyByKey(key);
    }
}

// ============================================================================
// HMR Support
// ============================================================================

// Check if HMR is available (Vite)
if (import.meta.hot) {
    // Accept loader updates and reload currently registered built-ins.
    import.meta.hot.accept("./lib/strategies/manifest-loaders", async () => {
        logRegistryInfo('[HMR] Strategy loaders updated, reloading...');

        const loadedBuiltInKeys = strategyRegistry.keys().filter((key) => builtInStrategyKeys.has(key));
        strategyRegistry.clear();
        builtInStrategyKeys.clear();
        await loadBuiltInStrategies(loadedBuiltInKeys);

        logRegistryInfo('[HMR] Strategies reloaded successfully');
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
const CUSTOM_STRATEGIES_STORAGE = {
    key: CUSTOM_STRATEGIES_KEY,
    schema: "strategy-registry.custom-strategies",
    version: 1,
} as const;

export function saveCustomStrategiesToStorage(configs: CustomStrategyConfig[]): void {
    const saved = writePersistedJson({
        ...CUSTOM_STRATEGIES_STORAGE,
        data: configs,
        onError: (error) => {
            console.error('[StrategyRegistry] Failed to save custom strategies:', error);
        },
    });
    if (saved) {
        logRegistryInfo(`[StrategyRegistry] Saved ${configs.length} custom strategies to localStorage`);
    }
}

export function loadCustomStrategiesFromStorage(): CustomStrategyConfig[] {
    const configs = readPersistedJson<CustomStrategyConfig[]>({
        ...CUSTOM_STRATEGIES_STORAGE,
        fallback: [],
        migrate: ({ data }) => Array.isArray(data) ? data as CustomStrategyConfig[] : [],
        onError: (error) => {
            console.error('[StrategyRegistry] Failed to load custom strategies:', error);
        },
    });
    if (configs.length > 0) {
        logRegistryInfo(`[StrategyRegistry] Loaded ${configs.length} custom strategies from localStorage`);
    }
    return configs;
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
    const seen = new Set<string>();
    const result: Array<{ key: string; name: string; description: string }> = [];

    const registeredKeys = strategyRegistry.keys();
    for (const key of registeredKeys) {
        seen.add(key);
        const strategy = strategyRegistry.get(key)!;
        result.push({
            key,
            name: strategy.name,
            description: strategy.description,
        });
    }

    for (const meta of getAllBuiltInMeta()) {
        if (!seen.has(meta.key)) {
            seen.add(meta.key);
            result.push({
                key: meta.key,
                name: meta.name,
                description: meta.description,
            });
        }
    }

    return result;
}

/**
 * Validate a strategy key
 */
export function isValidStrategyKey(key: string): boolean {
    return /^[a-z][a-z0-9_]*$/.test(key);
}

export function isBuiltInStrategyKey(key: string): boolean {
    return isBuiltInKey(key);
}

export function getBuiltInMeta(key: string): BuiltInStrategyMeta | undefined {
    return getBuiltInStrategyMeta(key);
}

export function getStrategyKind(key: string, strategy?: Strategy): StrategyKind {
    const meta = getBuiltInStrategyMeta(key);

    if (strategy?.polymarket1sConfig || meta?.polymarket1sConfig) {
        return "polymarket-1s";
    }

    if (strategy?.crossSymbolConfig || meta?.crossSymbolConfig) {
        return "cross-symbol";
    }

    return "standard";
}

export function getStrategyKindTitle(kind: StrategyKind): string {
    if (kind === "polymarket-1s") {
        return "Uses 1s Polymarket price helpers";
    }
    if (kind === "cross-symbol") {
        return "Uses cross-symbol price helpers";
    }
    return "Standard strategy";
}

// Export for debugging in browser console
if (typeof window !== 'undefined') {
    (window as any).__strategyRegistry = strategyRegistry;
    (window as any).__indicatorHelpers = indicatorHelpers;
    (window as any).__createCustomStrategy = createCustomStrategy;
}
