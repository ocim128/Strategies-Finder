import type { Strategy } from "../types/strategies";
import {
    registerLoadedBuiltInStrategy,
    unregisterLoadedBuiltInStrategy,
} from "./built-in-catalog";
import {
    strategyManifest,
    createStrategiesRecordFromManifest,
    type StrategyManifestEntry,
} from "./manifest-eager";

export type { StrategyManifestEntry };
export { strategyManifest };

const eagerStrategies = createStrategiesRecordFromManifest(strategyManifest);

for (const entry of strategyManifest) {
    registerLoadedBuiltInStrategy(entry.key, entry.strategy);
}

export const strategies: Record<string, Strategy> = new Proxy(eagerStrategies, {
    set(target, property, value) {
        if (typeof property === "string") {
            registerLoadedBuiltInStrategy(property, value as Strategy);
        }
        return Reflect.set(target, property, value);
    },
    deleteProperty(target, property) {
        if (typeof property === "string") {
            unregisterLoadedBuiltInStrategy(property);
        }
        return Reflect.deleteProperty(target, property);
    },
});
