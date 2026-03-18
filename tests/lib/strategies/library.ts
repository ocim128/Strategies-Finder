import type { Strategy } from "../types/strategies";
import {
    strategyManifest,
    createStrategiesRecordFromManifest,
    type StrategyManifestEntry,
} from "./manifest";

export type { StrategyManifestEntry };
export { strategyManifest };

export const strategies: Record<string, Strategy> =
    createStrategiesRecordFromManifest(strategyManifest);
