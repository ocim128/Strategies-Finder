/**
 * Numeric rounding helpers.
 *
 * `roundToHundredths` is the shared "diagnostic value" rounding: a
 * non-finite input collapses to `0` before the two-decimal round, so a
 * `NaN`/`Infinity` timing or count never leaks into a report. It is the
 * single owner for the copies that previously lived in the finder
 * diagnostics/quality modules and the backtest engine/entry diagnostics.
 *
 * Note: this is intentionally *not* the same formula as the other rounding
 * helpers in the repo (`roundRangeValue` rounds to 3 decimals,
 * `roundMetric` to 4, `roundScore`/`roundDiagnosticMs` have no finite guard),
 * so those stay where they are.
 */
export function roundToHundredths(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}
