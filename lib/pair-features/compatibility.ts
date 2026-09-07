import type {
    PairFeatureCapability,
    PairFeatureCompatibilityEntry,
    PairFeatureCompatibilityRequest,
    PairFeatureCompatibilityResult,
    PairFeatureCompatibilityRefusalReason,
} from "./types";

export const PAIR_HORIZON_OUTCOMES_CAPABILITY = "pair_horizon_outcomes" as const;
export const EMBEDDED_FEATURES_V3_CAPABILITY = "embedded_features_v3" as const;

/** Embedded v3 scalar fields that legacy pair-selection rules can read. */
export const EMBEDDED_FEATURES_V3_COLUMNS = [
    "feat_entryRangePosition",
    "feat_atrPct",
    "feat_return20",
    "feat_gapPct",
    "feat_dow",
    "feat_hour",
    "feat_pairWinRatePrior",
    "feat_pairTradesPrior",
    "feat_barsSincePairLastFire",
    "feat_pairSpreadVolatility20",
    "feat_legVolatilityRatio20",
] as const;

const V2_CAPABILITIES: readonly PairFeatureCapability[] = [];
const V3_CAPABILITIES: readonly PairFeatureCapability[] = [
    PAIR_HORIZON_OUTCOMES_CAPABILITY,
    EMBEDDED_FEATURES_V3_CAPABILITY,
    ...EMBEDDED_FEATURES_V3_COLUMNS,
];

/**
 * Explicitly understood format pairs. The v2 rows are replay-compatible only;
 * they deliberately do not advertise fixed-horizon outcomes.
 */
export const PAIR_FEATURE_COMPATIBILITY_TABLE: readonly PairFeatureCompatibilityEntry[] = [
    { ledgerVersion: 2, featureVersion: 2, capabilities: V2_CAPABILITIES },
    { ledgerVersion: 2, featureVersion: 3, capabilities: V2_CAPABILITIES },
    { ledgerVersion: 3, featureVersion: 3, capabilities: V3_CAPABILITIES },
];

function isVersion(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function displayVersion(value: unknown): string {
    return typeof value === "number" ? `v${String(value)}` : String(value);
}

function refusal(
    request: PairFeatureCompatibilityRequest,
    reason: PairFeatureCompatibilityRefusalReason,
    message: string,
    capabilities: readonly PairFeatureCapability[] = [],
    missingCapabilities: readonly PairFeatureCapability[] = [],
): PairFeatureCompatibilityResult {
    return {
        supported: false,
        ledgerVersion: isVersion(request.ledgerVersion) ? request.ledgerVersion : null,
        featureVersion: isVersion(request.featureVersion) ? request.featureVersion : null,
        capabilities,
        missingCapabilities,
        reason,
        message,
    };
}

/** Resolve one explicit format pair and its requested capabilities. */
export function resolvePairFeatureCompatibility(
    request: PairFeatureCompatibilityRequest,
): PairFeatureCompatibilityResult {
    if (!isVersion(request.ledgerVersion)) {
        return refusal(
            request,
            "unknown_ledger_version",
            `Pair selection requires a supported ledger version; folder has ledger ${displayVersion(request.ledgerVersion)}. Re-run the batch.`,
        );
    }
    if (!isVersion(request.featureVersion)) {
        return refusal(
            request,
            "unknown_feature_version",
            `Pair selection requires a supported feature version; folder has featureVersion ${displayVersion(request.featureVersion)}. Re-run the batch.`,
        );
    }

    const entry = PAIR_FEATURE_COMPATIBILITY_TABLE.find(
        (candidate) => candidate.ledgerVersion === request.ledgerVersion
            && candidate.featureVersion === request.featureVersion,
    );
    if (!entry) {
        return refusal(
            request,
            "unsupported_version_pair",
            `Pair selection does not understand ledger ${displayVersion(request.ledgerVersion)} with featureVersion ${displayVersion(request.featureVersion)}. Re-run the batch.`,
        );
    }

    const requiredCapabilities = request.requiredCapabilities ?? [];
    const missingCapabilities = requiredCapabilities.filter(
        (capability, index) => !entry.capabilities.includes(capability)
            && requiredCapabilities.indexOf(capability) === index,
    );
    if (missingCapabilities.length > 0) {
        return refusal(
            request,
            "missing_capability",
            `Pair selection requires capability ${missingCapabilities.map((capability) => `"${capability}"`).join(", ")}; `
            + `ledger ${displayVersion(request.ledgerVersion)} with featureVersion ${displayVersion(request.featureVersion)} does not provide it. `
            + "Re-run the batch to export the required capability.",
            entry.capabilities,
            missingCapabilities,
        );
    }

    return {
        supported: true,
        ledgerVersion: entry.ledgerVersion,
        featureVersion: entry.featureVersion,
        capabilities: entry.capabilities,
        missingCapabilities: [],
        reason: null,
        message: null,
    };
}
