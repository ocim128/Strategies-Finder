import { syncStrategyManifest } from "./strategy-manifest-generator";

const result = syncStrategyManifest();
console.log(`[StrategyManifest] Synced ${result.count} built-in strategies -> ${result.path}`);
