/** Frozen definitions; these are provenance, never search parameters. */
export const FINDER_SUPPORT_ARMS_V2 = Object.freeze({
    version: "finder-causal-arms-v2" as const,
    supportIntervals: 24,
    supportClock: "elapsed_seconds" as const,
    degree: "valid_loaded_pair_identities" as const,
});
export function compactCausalArmDefinitions(value: unknown): CausalArmDefinitions | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    // Legacy v1 snapshots retain their version and the unchanged support rules.
    // Removed price/graph definitions and other unknown fields are discarded.
    if (row.version !== "finder-causal-arms-v1" && row.version !== FINDER_SUPPORT_ARMS_V2.version) return undefined;
    return Object.entries(FINDER_SUPPORT_ARMS_V2).every(([key, expected]) => key === "version" || row[key] === expected)
        ? { ...FINDER_SUPPORT_ARMS_V2, version: row.version } : undefined;
}

export type CausalArmDefinitions = Omit<typeof FINDER_SUPPORT_ARMS_V2, "version"> & {
    version: "finder-causal-arms-v1" | "finder-causal-arms-v2";
};
