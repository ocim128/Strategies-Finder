/**
 * Cross-symbol UI controller.
 *
 * Shows/hides the secondary symbol input based on the current strategy,
 * populates the default label, and wires persistence through the standard
 * backtest-settings DOM contract.
 */

import { state } from "./state";
import { strategyRegistry } from "../strategyRegistry";
import { createCrossSymbolDom, type CrossSymbolDomElements } from "./cross-symbol-dom";
import { settingsManager } from "./settings-manager";

let dom: CrossSymbolDomElements | null = null;

function getDom(): CrossSymbolDomElements | null {
    return dom ??= createCrossSymbolDom();
}

/**
 * Called once during app bootstrap after HTML partials are injected.
 * Wires up event listeners and sets initial visibility.
 */
export function initCrossSymbolUI(): void {
    const elements = getDom();
    if (!elements) return;

    // Wire input changes to auto-save
    elements.input.addEventListener("change", () => {
        settingsManager.saveSettingsDebounced();
    });
    elements.input.addEventListener("input", () => {
        settingsManager.saveSettingsDebounced();
    });

    // React to strategy changes
    state.subscribe("currentStrategyKey", () => {
        syncCrossSymbolVisibility();
    });

    // Set initial state
    syncCrossSymbolVisibility();
}

/**
 * Show/hide the cross-symbol row and update the default label based
 * on the currently selected strategy.
 */
export function syncCrossSymbolVisibility(): void {
    const elements = getDom();
    if (!elements) return;

    const strategy = strategyRegistry.get(state.currentStrategyKey);
    const config = strategy?.crossSymbolConfig;

    if (config) {
        elements.row.style.display = "";
        elements.defaultLabel.textContent = config.defaultSymbol;

        // If the strategy doesn't allow user override, disable the input
        if (config.userSelectable === false) {
            elements.input.disabled = true;
            elements.input.value = config.defaultSymbol;
            elements.input.placeholder = config.defaultSymbol;
        } else {
            elements.input.disabled = false;
            elements.input.placeholder = `e.g. ${config.defaultSymbol}`;
        }
    } else {
        elements.row.style.display = "none";
        elements.defaultLabel.textContent = "";
    }
}

/**
 * Programmatically set the secondary symbol input value.
 * Used when loading saved configs.
 */
export function setCrossSymbolInputValue(value: string): void {
    const elements = getDom();
    if (!elements) return;
    elements.input.value = value;
}

/**
 * Read the current secondary symbol input value.
 */
export function getCrossSymbolInputValue(): string {
    const elements = getDom();
    if (!elements) return "";
    return elements.input.value.trim().toUpperCase();
}
