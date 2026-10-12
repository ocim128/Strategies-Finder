/**
 * Shared helpers for the offline strategy-hunt CLIs (`alpha-sweep`,
 * `massive-alpha-sweep`, `verify-alpha`, `walk-forward-hunt`, `signal-tower`, `surgical-optimization`).
 * Each of them used to carry its own copy of these two functions; they now
 * share one implementation.
 *
 * `buildGeneticConfig` is deliberately NOT here: although two of the scripts
 * define byte-identical copies, it depends on each script's own local
 * `CliOptions` type, so sharing it would mean unifying those types first.
 */
import type { Strategy, TradeDirection } from "../../lib/types/strategies";

/**
 * The direction a strategy should be exercised in: its declared metadata
 * direction when that is one of the three tradeable values, otherwise `long`.
 */
export function inferDirection(strategy: Strategy): TradeDirection {
    const direction = strategy.metadata?.direction;
    if (direction === "short" || direction === "both" || direction === "long") return direction;
    return "long";
}

/** Deterministic FNV-1a-style seed derived from the symbol and strategy key. */
export function deriveSeed(baseSeed: number, symbol: string, strategyKey: string): number {
    const key = `${symbol}|${strategyKey}`;
    let hash = baseSeed >>> 0;
    for (let i = 0; i < key.length; i++) {
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) || 1;
}
