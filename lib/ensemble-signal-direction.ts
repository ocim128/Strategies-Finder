export type EnsembleRecipeReplayDirectionOverride = "auto" | "short" | "long" | "combined";

export function normalizeEnsembleRecipeReplayDirectionOverride(
    value: unknown,
    fallback: EnsembleRecipeReplayDirectionOverride = "auto"
): EnsembleRecipeReplayDirectionOverride {
    return value === "short" || value === "long" || value === "combined" || value === "auto"
        ? value
        : fallback;
}

export function describeEnsembleRecipeReplayDirectionOverride(
    value: EnsembleRecipeReplayDirectionOverride
): string {
    switch (value) {
        case "short":
            return "Short Only";
        case "long":
            return "Long Only";
        case "combined":
            return "Combined";
        case "auto":
        default:
            return "Auto";
    }
}

export function buildEnsembleRecipeVariantSlug(
    baseSlug: string,
    directionOverride: EnsembleRecipeReplayDirectionOverride
): string {
    return directionOverride === "auto"
        ? baseSlug
        : `${baseSlug}-${directionOverride}`;
}
