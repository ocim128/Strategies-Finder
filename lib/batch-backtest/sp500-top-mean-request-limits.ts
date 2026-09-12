/**
 * Shared TOP_MEAN request limit contract.
 *
 * Used by the server route (hard 400s) and kept as the single source of truth
 * for the legitimate UI range so browser defaults and server caps cannot drift.
 */

export const TOP_MEAN_HORIZONS_MAX_LENGTH = 8;
export const TOP_MEAN_HORIZONS_MAX_VALUE = 1000;
export const TOP_MEAN_WORKER_COUNT_MIN = 1;
export const TOP_MEAN_WORKER_COUNT_MAX = 24;
/** Matches the Balanced Generator UI clamp (1..1_000_000). */
export const TOP_MEAN_MAX_PAIRS_MAX = 1_000_000;

/** Cap-tilt weighting enum (docs/open-score-cap-tilt.md); "off" = baseline. */
export const TOP_MEAN_CAP_TILT_WEIGHTS = ["off", "smallBase2x", "largeBase2x"] as const;
export type TopMeanCapTiltWeight = (typeof TOP_MEAN_CAP_TILT_WEIGHTS)[number];
export type TopMeanActiveCapTiltWeight = Exclude<TopMeanCapTiltWeight, "off">;

export type TopMeanValidatedLimits = {
    horizons: number[];
    workerCount?: number;
    maxPairs?: number;
    capTiltWeight?: TopMeanActiveCapTiltWeight;
};

export type TopMeanLimitValidationResult =
    | { ok: true; value: TopMeanValidatedLimits }
    | { ok: false; error: string };

/**
 * Validate and normalize TOP_MEAN workload inputs.
 * Rejects pathological arrays/values that would amplify CPU work; preserves
 * legitimate UI values (handful of small horizons, 1..24 workers, bounded pairs).
 */
export function validateTopMeanRequestLimits(input: {
    horizons: unknown;
    workerCount?: unknown;
    maxPairs?: unknown;
    capTiltWeight?: unknown;
}): TopMeanLimitValidationResult {
    if (!Array.isArray(input.horizons) || input.horizons.length === 0) {
        return { ok: false, error: "Missing required non-empty array: horizons." };
    }
    if (input.horizons.length > TOP_MEAN_HORIZONS_MAX_LENGTH) {
        return {
            ok: false,
            error: `Too many horizons (${input.horizons.length}); limit is ${TOP_MEAN_HORIZONS_MAX_LENGTH}.`,
        };
    }

    const horizons: number[] = [];
    const seen = new Set<number>();
    for (const raw of input.horizons) {
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
            return {
                ok: false,
                error: "Each horizon must be a positive finite integer.",
            };
        }
        if (raw > TOP_MEAN_HORIZONS_MAX_VALUE) {
            return {
                ok: false,
                error: `Horizon ${raw} exceeds the maximum of ${TOP_MEAN_HORIZONS_MAX_VALUE}.`,
            };
        }
        if (seen.has(raw)) {
            return { ok: false, error: `Duplicate horizon value: ${raw}.` };
        }
        seen.add(raw);
        horizons.push(raw);
    }

    let workerCount: number | undefined;
    if (input.workerCount !== undefined && input.workerCount !== null) {
        if (
            typeof input.workerCount !== "number"
            || !Number.isFinite(input.workerCount)
            || !Number.isInteger(input.workerCount)
            || input.workerCount < TOP_MEAN_WORKER_COUNT_MIN
            || input.workerCount > TOP_MEAN_WORKER_COUNT_MAX
        ) {
            return {
                ok: false,
                error: `workerCount must be an integer between ${TOP_MEAN_WORKER_COUNT_MIN} and ${TOP_MEAN_WORKER_COUNT_MAX}.`,
            };
        }
        workerCount = input.workerCount;
    }

    let maxPairs: number | undefined;
    if (input.maxPairs !== undefined && input.maxPairs !== null) {
        if (
            typeof input.maxPairs !== "number"
            || !Number.isFinite(input.maxPairs)
            || !Number.isInteger(input.maxPairs)
            || input.maxPairs <= 0
            || input.maxPairs > TOP_MEAN_MAX_PAIRS_MAX
        ) {
            return {
                ok: false,
                error: `maxPairs must be a positive integer up to ${TOP_MEAN_MAX_PAIRS_MAX}.`,
            };
        }
        maxPairs = input.maxPairs;
    }

    let capTiltWeight: TopMeanActiveCapTiltWeight | undefined;
    if (input.capTiltWeight !== undefined && input.capTiltWeight !== null && input.capTiltWeight !== "off") {
        if (
            typeof input.capTiltWeight !== "string"
            || (input.capTiltWeight !== "smallBase2x" && input.capTiltWeight !== "largeBase2x")
        ) {
            return {
                ok: false,
                error: `Invalid capTiltWeight "${String(input.capTiltWeight)}". Allowed values: ${TOP_MEAN_CAP_TILT_WEIGHTS.join(", ")}.`,
            };
        }
        capTiltWeight = input.capTiltWeight;
    }

    return {
        ok: true,
        value: {
            horizons,
            ...(workerCount !== undefined ? { workerCount } : {}),
            ...(maxPairs !== undefined ? { maxPairs } : {}),
            ...(capTiltWeight !== undefined ? { capTiltWeight } : {}),
        },
    };
}
