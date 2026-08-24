/**
 * MAX_ACTIVE research contract — frozen tie/bootstrap versions and the
 * holdout registration shape.
 *
 * Pure leaf: no DOM, no lightweight-charts, no Batch artifact I/O. Safe to
 * import from both the cjs-bundled vite config path and the browser service.
 *
 * Research boundary: this module freezes the *rules* (tie-break, block split,
 * bootstrap seed) so a forward MAX_ACTIVE run cannot be rescued by an
 * untracked default after the fact. The holdout registration itself is
 * threaded through the run payload as `maxActiveResearchRegistration`; while
 * that field is null, every report is `EXPLORATORY`.
 */

// ---------------------------------------------------------------------------
// Versioned rules (Phase 0 freeze)
// ---------------------------------------------------------------------------

/** Selector tie-break rule: smallest unsigned FNV-1a 64-bit digest wins. */
export const MAX_ACTIVE_TIE_VERSION = "max_active_tie_v1" as const;

/** Fixed tie seed — every selector and event uses this. */
export const MAX_ACTIVE_TIE_SEED = 1;

/** Fixed block count and bootstrap samples for the formal CI. */
export const MAX_ACTIVE_BLOCK_COUNT = 10;
export const MAX_ACTIVE_BOOTSTRAP_SAMPLES = 10_000;
export const MAX_ACTIVE_BOOTSTRAP_SEED = 1;

/** Phase 2 pool-rule analysis constants. Keep these beside the frozen
 * bootstrap/tie rules so the offline analyzer cannot drift from registration. */
export const PAIRLIST_POOL_RULE_LOOKBACK_BARS = 120;
export const PAIRLIST_POOL_RULE_BREADTH_THRESHOLD = 0.5;
export const PAIRLIST_POOL_RULE_PRIMARY_SIZE = 35;
export const PAIRLIST_POOL_RULE_SECONDARY_SIZES = [21, 49] as const;
export const PAIRLIST_POOL_RULE_HORIZONS = [12, 24, 48] as const;
export const PAIRLIST_POOL_RULE_POOL_VERSION = "BAL679.v1" as const;
export const PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS = 50;
export const PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC = Math.floor(Date.parse("2025-01-10T00:00:00.000Z") / 1000);
export const PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC = Math.floor(Date.parse("2025-12-31T23:59:59.999Z") / 1000);
export const PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
export const PAIRLIST_POOL_RULE_VALIDATION_TO_SEC = Math.floor(Date.parse("2026-08-24T23:59:59.999Z") / 1000);
export const PAIRLIST_POOL_RULE_CI_LOW_QUANTILE = 0.025;
export const PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE = 0.975;
export const PAIRLIST_POOL_RULE_PAIRED_FLOOR = -0.005;

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
