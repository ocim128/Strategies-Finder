import { getStrategyList } from "../../strategyRegistry";
import { loadBuiltInStrategyByKey, strategyRegistry, ensureStrategyKeysLoaded } from "../../strategyRegistry";
import type { Strategy, StrategyParams } from "../types/strategies";
import { exitStrategyParamManager } from "../param-manager";
import type { UiEventHandlersDom } from "./ui-event-handlers-dom";
import { parseInputNumber } from "../dom-input-readers";

/**
 * Wiring for the Exit Strategy Override settings sub-section.
 *
 * Contract (mirrors confirmationStrategies pattern):
 *   - #disableSignalExits + #exitStrategyOverrideEnabled gate the visibility of
 *     #exitStrategyOverrideConfig (the dropdown + param form).
 *   - #exitStrategyKey <select> is populated from getStrategyList().
 *   - #exitStrategyParamsContainer holds a param form rendered by exitStrategyParamManager.
 *   - #exitStrategyParams is a hidden <input> holding JSON-serialized params, which is what
 *     the DOM contract reads back into settings.
 *
 * Effective only when disableSignalExits is on. The toggle/section are inert otherwise
 * but stay visible so the user can configure before enabling.
 */
export function setupExitStrategyOverride(dom: UiEventHandlersDom): void {
    const disableSignalExits = dom.disableSignalExits;
    const toggle = dom.exitStrategyOverrideEnabled;
    const row = dom.exitStrategyOverrideRow;
    const config = dom.exitStrategyOverrideConfig;
    const keySelect = dom.exitStrategyKey;
    const paramsContainer = dom.exitStrategyParamsContainer;
    const paramsHidden = dom.exitStrategyParams;

    if (!disableSignalExits || !toggle || !row || !config || !keySelect || !paramsContainer || !paramsHidden) {
        return;
    }

    let currentStrategy: Strategy | null = null;
    let strategyDropdownSignature = "";

    const populateStrategyDropdown = (): void => {
        const strategies = getStrategyList();
        const signature = strategies.map(({ key, name }) => `${key}\u0000${name}`).join('\u0001');
        const currentValue = strategies.some((s) => s.key === keySelect.value)
            ? keySelect.value
            : (strategies[0]?.key ?? "");

        if (signature !== strategyDropdownSignature) {
            const fragment = document.createDocumentFragment();
            strategies.forEach(({ key, name, description }) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = name;
                option.title = description;
                fragment.appendChild(option);
            });
            keySelect.replaceChildren(fragment);
            strategyDropdownSignature = signature;
        }

        const found = strategies.some((s) => s.key === currentValue);
        keySelect.value = found ? currentValue : (strategies[0]?.key ?? "");
    };

    const resolveStrategy = async (key: string): Promise<Strategy | null> => {
        const trimmed = key.trim();
        if (!trimmed) return null;
        await ensureStrategyKeysLoaded([trimmed]);
        const direct = strategyRegistry.get(trimmed);
        if (direct) return direct;
        const loaded = await loadBuiltInStrategyByKey(trimmed);
        return loaded ?? null;
    };

    const syncParamsFromHiddenInput = (): void => {
        if (!currentStrategy) return;
        const params = readParamsFromHidden(paramsHidden.value);
        exitStrategyParamManager.setValues(currentStrategy, params);
    };

    const syncParamsInputFromForm = (): void => {
        if (!currentStrategy) return;
        const params = exitStrategyParamManager.getValues(currentStrategy);
        paramsHidden.value = JSON.stringify(params);
    };

    const renderStrategyParams = async (): Promise<void> => {
        const key = keySelect.value;
        currentStrategy = await resolveStrategy(key);
        if (!currentStrategy) {
            paramsContainer.replaceChildren();
            return;
        }
        exitStrategyParamManager.render(currentStrategy);
        syncParamsFromHiddenInput();
        syncParamsInputFromForm();
    };

    const applyVisibility = (): void => {
        const disableExitsOn = disableSignalExits.checked;
        const overrideOn = toggle.checked;
        // Row visibility follows disableSignalExits; inner config follows the override toggle.
        row.classList.toggle('is-hidden', !disableExitsOn);
        config.style.display = overrideOn && disableExitsOn ? '' : 'none';
        // Disable the override toggle when disableSignalExits is off so the
        // inert-but-visible contract is obvious.
        toggle.disabled = !disableExitsOn;
    };

    // Initial dropdown population. Strategies may not all be loaded yet; do a best-effort
    // sync pass and rely on later change events when more strategies register.
    populateStrategyDropdown();

    keySelect.addEventListener('change', () => {
        void renderStrategyParams();
    });
    toggle.addEventListener('change', () => {
        applyVisibility();
        // When enabling, ensure the params form reflects the current selection.
        if (toggle.checked) {
            void renderStrategyParams();
        }
    });
    disableSignalExits.addEventListener('change', () => {
        applyVisibility();
    });

    // Sync hidden input when the param form changes. Use document-level delegation because
    // exitStrategyParamManager replaces children on render.
    paramsContainer.addEventListener('input', () => {
        syncParamsInputFromForm();
    });
    paramsContainer.addEventListener('change', () => {
        syncParamsInputFromForm();
    });
    // Reflect external writes to the hidden input (e.g. settings load, Finder Apply).
    paramsHidden.addEventListener('change', () => {
        syncParamsFromHiddenInput();
    });

    applyVisibility();
    void renderStrategyParams();
}

function readParamsFromHidden(raw: string): StrategyParams {
    try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const params: StrategyParams = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const numeric = typeof value === "number"
                ? value
                : parseInputNumber(String(value));
            if (typeof numeric === "number" && Number.isFinite(numeric)) {
                params[key] = numeric;
            }
        }
        return params;
    } catch {
        return {};
    }
}
