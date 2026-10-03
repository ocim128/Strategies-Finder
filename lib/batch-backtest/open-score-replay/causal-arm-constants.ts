/** Frozen definitions; these are provenance, never search parameters. */
export const FINDER_CAUSAL_ARMS_V1 = Object.freeze({
    version: "finder-causal-arms-v1" as const,
    supportIntervals: 24,
    priceReturns: 24,
    volatilityFloor: 1e-8,
    graphResidualTolerance: 1e-10,
    graphMaxIterations: 500,
    graphRankingPrecision: 1e-8,
    supportClock: "elapsed_seconds" as const,
    degree: "valid_loaded_pair_identities" as const,
    graphComponent: "largest_vertices_lexicographic_names" as const,
});
export function compactCausalArmDefinitions(value: unknown): typeof FINDER_CAUSAL_ARMS_V1 | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    return Object.entries(FINDER_CAUSAL_ARMS_V1).every(([key, expected]) => row[key] === expected) ? { ...FINDER_CAUSAL_ARMS_V1 } : undefined;
}

export type CausalArmDefinitions = typeof FINDER_CAUSAL_ARMS_V1;
