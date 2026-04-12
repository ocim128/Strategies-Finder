/**
 * DOM contracts for cross-symbol strategy UI.
 *
 * Structural ids live in `html-partials/tab-settings-section-execution.html`.
 */

export const CROSS_SYMBOL_REQUIRED_IDS = [
    "crossSymbolRow",
    "crossSymbolSecondary",
    "crossSymbolDefault",
] as const;

export interface CrossSymbolDomElements {
    /** Outer param-row that is shown/hidden based on strategy type. */
    row: HTMLElement;
    /** Text input for the secondary symbol override. */
    input: HTMLInputElement;
    /** Span showing the strategy's default secondary symbol. */
    defaultLabel: HTMLElement;
}

export function createCrossSymbolDom(): CrossSymbolDomElements | null {
    const row = document.getElementById("crossSymbolRow");
    const input = document.getElementById("crossSymbolSecondary") as HTMLInputElement | null;
    const defaultLabel = document.getElementById("crossSymbolDefault");

    if (!row || !input || !defaultLabel) return null;

    return { row, input, defaultLabel };
}
