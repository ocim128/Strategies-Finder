/**
 * MAX_ACTIVE research contract — frozen tie/bootstrap/threshold versions,
 * committed holdout registration, and verdict helpers.
 *
 * Pure leaf: no DOM, no lightweight-charts, no Batch artifact I/O. Safe to
 * import from both the cjs-bundled vite config path and the browser service.
 *
 * Research boundary: this module freezes the *rules* (tie-break, block split,
 * bootstrap seed, holdout thresholds) so a forward MAX_ACTIVE run cannot be
 * rescued by an untracked default after the fact. The committed holdout
 * registration is absent until Phase 4 commits concrete UTC dates + hashes
 * into {@link MAX_ACTIVE_HOLDOUT_REGISTRATION}; while it is `null`, every
 * report is `EXPLORATORY`.
 */

// ---------------------------------------------------------------------------
// Versioned rules (Phase 0 freeze)
// ---------------------------------------------------------------------------

/** Selector tie-break rule: smallest unsigned FNV-1a 64-bit digest wins. */
export const MAX_ACTIVE_TIE_VERSION = "max_active_tie_v1" as const;
/** Block bootstrap rule: 10 chronological blocks, 10_000 seeded resamples. */
export const MAX_ACTIVE_BOOTSTRAP_VERSION = "max_active_bootstrap_v1" as const;
/** Sufficiency/pass threshold set (see {@link MaxActiveThresholds}). */
export const MAX_ACTIVE_THRESHOLDS_VERSION = "max_active_thresholds_v1" as const;

/** Fixed tie seed — every selector and event uses this. */
export const MAX_ACTIVE_TIE_SEED = 1;

/** Fixed block count and bootstrap samples for the formal CI. */
export const MAX_ACTIVE_BLOCK_COUNT = 10;
export const MAX_ACTIVE_BOOTSTRAP_SAMPLES = 10_000;
export const MAX_ACTIVE_BOOTSTRAP_SEED = 1;

/** Primary research horizon (bars). 36 and 96 are secondary robustness horizons. */
export const MAX_ACTIVE_PRIMARY_HORIZON = 72;
export const MAX_ACTIVE_SECONDARY_HORIZONS: readonly number[] = [36, 96];
export const MAX_ACTIVE_HORIZONS: readonly [number, number, number] = [36, 72, 96];

// ---------------------------------------------------------------------------
// FNV-1a 64-bit hash (deterministic; two uint32 halves)
// ---------------------------------------------------------------------------

/**
 * Canonical FNV-1a 64-bit constants. The 64-bit offset basis
 * `0xcbf29ce484222325` splits into a high half `0xcbf29ce4` and a low half
 * `0x84222325`; the prime `0x00000100000001b3` splits into
 * high `0x00000100` and low `0x000001b3`.
 */
const FNV64_OFFSET_HI = 0xcbf29ce4 >>> 0;
const FNV64_OFFSET_LO = 0x84222325 >>> 0;
const FNV64_PRIME_HI = 0x00000100 >>> 0;
const FNV64_PRIME_LO = 0x000001b3 >>> 0;

/**
 * Deterministic FNV-1a 64-bit digest over UTF-8 text, returned as 16-char
 * lowercase hex. Reproducibility identifier (NOT a security check): used for
 * pair-list provenance, asset-list hashing, and selector tie-breaks.
 *
 * JS lacks native u64; we keep two 32-bit halves and propagate overflow.
 * For `H = H_lo + 2^32 * H_hi` and prime `P = P_lo + 2^32 * P_hi`:
 *   new_lo = (H_lo * P_lo) mod 2^32
 *   new_hi = (carry(H_lo * P_lo) + H_lo * P_hi + H_hi * P_lo) mod 2^32
 * The `H_hi * P_hi` term overflows past 2^64 and is discarded by the modulus.
 * `lo * P_lo` is at most ~2^40 so the product is exact in double precision;
 * carry is recovered with a plain floor divide by 2^32.
 */
export function fnv1a64Hex(text: string): string {
    const bytes = TEXT_ENCODER.encode(text);
    let hi = FNV64_OFFSET_HI;
    let lo = FNV64_OFFSET_LO;
    for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i]!;
        lo = (lo ^ b) >>> 0;
        const loTimesPrimeLo = lo * FNV64_PRIME_LO;
        const newLo = loTimesPrimeLo >>> 0;
        const carry = Math.floor(loTimesPrimeLo / 0x100000000) >>> 0;
        const newHi = (carry + Math.imul(lo, FNV64_PRIME_HI) + Math.imul(hi, FNV64_PRIME_LO)) >>> 0;
        lo = newLo;
        hi = newHi;
    }
    return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * Shared UTF-8 encoder. `TextEncoder` is available in both browser and Node
 * (>=12) and avoids the Node-only `Buffer` global so this leaf stays
 * bundle-safe for the esbuild cjs config bundle.
 */
const TEXT_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Tie-break
// ---------------------------------------------------------------------------

/**
 * Tie-break key for one (eventTimeSec, scoringAsset) pair. The smallest
 * digest wins; ties on identical digests fall back to asset name (reported,
 * the verdict becomes INSUFFICIENT_DATA instead of silently accepting it).
 *
 * Input: `tieVersion|tieSeed|truncatedEventTimeSec|scoringAsset`. The event
 * time is the integer Unix-second value the replay engine uses; `tieSeed`
 * is the versioned shared constant {@link MAX_ACTIVE_TIE_SEED}.
 */
export function tieBreakDigest(truncatedEventTimeSec: number, scoringAsset: string): string {
    return fnv1a64Hex(`${MAX_ACTIVE_TIE_VERSION}|${MAX_ACTIVE_TIE_SEED}|${Math.trunc(truncatedEventTimeSec)}|${scoringAsset}`);
}

/**
 * Compare two tied assets by tie-break digest, then by scoring-asset name as
 * a deterministic fallback (the caller surfaces a collision; the formal
 * verdict is INSUFFICIENT_DATA when one happens).
 */
export function compareByTieBreak(
    _truncatedEventTimeSec: number,
    aAsset: string,
    aDigest: string,
    bAsset: string,
    bDigest: string,
): number {
    if (aDigest !== bDigest) return aDigest < bDigest ? -1 : 1;
    return aAsset < bAsset ? -1 : aAsset > bAsset ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Holdout registration (committed only at Phase 4)
// ---------------------------------------------------------------------------

export interface MaxActiveResearchRegistrationV1 {
    schema: "batch.max_active_research.v1";
    registrationId: string;
    implementationCommit: string;
    registeredAtSec: number;
    decisionStartSec: number;
    decisionEndSec: number;
    evaluateNotBeforeSec: number;
    expectedPairListHash: string;
    expectedBatchFingerprint: string;
    interval: "4h";
    horizons: readonly [36, 72, 96];
    slippageBps: number;
    commissionPercent: number;
    tieVersion: "max_active_tie_v1";
    bootstrapVersion: "max_active_bootstrap_v1";
    thresholdVersion: "max_active_thresholds_v1";
}

/**
 * Committed holdout registration. `null` until Phase 4 commits concrete
 * UTC dates + implementation commit + pair-list hash + Batch fingerprint.
 * While this is `null`, every MAX_ACTIVE report is `EXPLORATORY`.
 */
export const MAX_ACTIVE_HOLDOUT_REGISTRATION: MaxActiveResearchRegistrationV1 | null = null;

// ---------------------------------------------------------------------------
// Thresholds (Phase 0 + Phase 4 freeze)
// ---------------------------------------------------------------------------

export interface MaxActiveThresholds {
    /** Artifact-eligible relationships at least this share of submitted canonical. */
    artifactEligibleShareMin: number;
    /** Hard-zero requirements for artifact-write and artifact-read failures. */
    artifactWriteFailuresMax: number;
    artifactReadFailuresMax: number;
    /** Replay-accepted pairs at least this share of submitted canonical. */
    replayAcceptedShareMin: number;
    /** Per-asset retained/submitted degree minimum. */
    perAssetRetentionShareMin: number;
    /** Max minus min asset retention ratio (percentage points). */
    assetRetentionSpreadPpMax: number;
    /** Horizon coverage minimum. */
    horizonCoverageShareMin: number;
    /** Primary (72-bar) eligible events minimum. */
    primaryEligibleEventsMin: number;
    /** ACTIVE_VS_SUBMITTED differing-selection events minimum. */
    activeVsSubmittedDiffEventsMin: number;
    /** Shared-mask non-overlap events minimum. */
    sharedMaskNonOverlapEventsMin: number;
    /** Primary events remaining after dominant-asset exclusion minimum. */
    dominantExcludedEventsMin: number;
    /** CI block count requirement (formal CI needs exactly this many blocks). */
    formalBlockCount: number;
    /** Minimum positive-block count for both primary comparisons. */
    primaryPositiveBlocksMin: number;
}

export const MAX_ACTIVE_THRESHOLDS: MaxActiveThresholds = {
    artifactEligibleShareMin: 0.95,
    artifactWriteFailuresMax: 0,
    artifactReadFailuresMax: 0,
    replayAcceptedShareMin: 0.95,
    perAssetRetentionShareMin: 0.9,
    assetRetentionSpreadPpMax: 10,
    horizonCoverageShareMin: 0.95,
    primaryEligibleEventsMin: 1_000,
    activeVsSubmittedDiffEventsMin: 200,
    sharedMaskNonOverlapEventsMin: 100,
    dominantExcludedEventsMin: 500,
    formalBlockCount: MAX_ACTIVE_BLOCK_COUNT,
    primaryPositiveBlocksMin: 7,
};

// ---------------------------------------------------------------------------
// Verdict helpers
// ---------------------------------------------------------------------------

export type ResearchMode = "EXPLORATORY" | "HOLDOUT";
export type ResearchVerdict = "NOT_EVALUATED" | "PASS" | "FAIL" | "INSUFFICIENT_DATA";

/**
 * Decide whether a report is `HOLDOUT` (verified provenance + exact
 * registered window + interval/costs/horizons match + evaluation time
 * reached). Otherwise it is `EXPLORATORY`.
 *
 * `batchFingerprintWithoutRegistration` MUST be the fingerprint computed
 * WITHOUT the registration itself (otherwise the registration would hash
 * itself recursively).
 */
export function resolveResearchMode(args: {
    registration: MaxActiveResearchRegistrationV1 | null;
    pairListHash: string | null;
    batchFingerprintWithoutRegistration: string | null;
    interval: string | null;
    decisionStartSec: number | null;
    decisionEndSec: number | null;
    slippageBps: number | null;
    commissionPercent: number | null;
    nowSec: number;
}): ResearchMode {
    const { registration, nowSec } = args;
    if (!registration) return "EXPLORATORY";
    if (nowSec < registration.evaluateNotBeforeSec) return "EXPLORATORY";
    if (args.pairListHash !== registration.expectedPairListHash) return "EXPLORATORY";
    if (args.batchFingerprintWithoutRegistration !== registration.expectedBatchFingerprint) return "EXPLORATORY";
    if (args.interval !== registration.interval) return "EXPLORATORY";
    if (registration.slippageBps !== args.slippageBps) return "EXPLORATORY";
    if (registration.commissionPercent !== args.commissionPercent) return "EXPLORATORY";
    if (args.decisionStartSec !== registration.decisionStartSec) return "EXPLORATORY";
    if (args.decisionEndSec !== registration.decisionEndSec) return "EXPLORATORY";
    return "HOLDOUT";
}
