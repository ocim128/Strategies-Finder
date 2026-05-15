import type { Strategy } from "../types/strategies";
import { builtInStrategyMeta, type BuiltInStrategyMeta } from "./manifest-meta";
import { builtInStrategyLoaders } from "./manifest-loaders";
import { builtInStrategyKeys } from "./manifest-keys";

const metaByKey = new Map<string, BuiltInStrategyMeta>(builtInStrategyMeta.map(m => [m.key, m]));
const loadedStrategies = new Map<string, Strategy>();
const loadingPromises = new Map<string, Promise<void>>();

export { type BuiltInStrategyMeta };

export function getBuiltInStrategyKeys(): readonly string[] {
    return builtInStrategyKeys;
}

export function getBuiltInStrategyMeta(key: string): BuiltInStrategyMeta | undefined {
    return metaByKey.get(key);
}

export function getAllBuiltInMeta(): readonly BuiltInStrategyMeta[] {
    return builtInStrategyMeta;
}

export function isBuiltInKey(key: string): boolean {
    return metaByKey.has(key);
}

export function getLoadedBuiltInStrategy(key: string): Strategy | undefined {
    return loadedStrategies.get(key);
}

export function registerLoadedBuiltInStrategy(key: string, strategy: Strategy): void {
    loadedStrategies.set(key, strategy);
}

export function unregisterLoadedBuiltInStrategy(key: string): void {
    loadedStrategies.delete(key);
}

export function isBuiltInStrategyLoaded(key: string): boolean {
    return loadedStrategies.has(key);
}

export async function ensureBuiltInStrategyLoaded(key: string): Promise<Strategy | undefined> {
    const already = loadedStrategies.get(key);
    if (already) return already;

    const loader = builtInStrategyLoaders[key];
    if (!loader) return undefined;

    const existing = loadingPromises.get(key);
    if (existing) {
        await existing;
        return loadedStrategies.get(key);
    }

    const promise = loader().then((strategy) => {
        loadedStrategies.set(key, strategy);
        loadingPromises.delete(key);
    });
    loadingPromises.set(key, promise);
    await promise;
    return loadedStrategies.get(key);
}

export async function ensureBuiltInStrategiesLoaded(keys: Iterable<string>): Promise<void> {
    await Promise.all(
        Array.from(keys).map(key => ensureBuiltInStrategyLoaded(key))
    );
}
