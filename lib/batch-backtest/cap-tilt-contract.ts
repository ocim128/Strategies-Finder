/**
 * Single source of truth for the CAP TILT weight enum
 * (docs/open-score-cap-tilt.md).
 *
 * Why a dependency-free leaf: the enum and its active-value predicate were
 * duplicated across the two browser payload builders, both server
 * validations, and the replay engine type. They must not drift — one route
 * accepting a value another rejects is a silent contract break. Safe to
 * import from the browser service, the vite.config-bundled server plugins,
 * and the replay engine alike (no imports at all).
 */
export const CAP_TILT_WEIGHTS = ["off", "smallBase2x", "largeBase2x"] as const;

export type CapTiltWeight = (typeof CAP_TILT_WEIGHTS)[number];

/** A weighting that actually tilts (everything but the "off" baseline). */
export type ActiveCapTiltWeight = Exclude<CapTiltWeight, "off">;

/** True for the weight values that apply a tilt; "off"/absent/garbage → false. */
export function isActiveCapTiltWeight(value: unknown): value is ActiveCapTiltWeight {
    return value === "smallBase2x" || value === "largeBase2x";
}
