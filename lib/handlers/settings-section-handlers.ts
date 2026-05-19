import { STRATEGY_PANEL_SETTINGS_SECTIONS } from "../strategy-panel-settings-registry";
import { parseInputNumber } from "../dom-input-readers";
import { ADVANCED_SIZING_SUBSECTION_IDS } from "../advanced-sizing-dom";
import { TAKE_PROFIT_MODE_PANEL_IDS } from "../take-profit-dom";
import { setStrategyTimeframeSettings } from "../state-actions";
import type { UiEventHandlersDom } from "./ui-event-handlers-dom";

const CONFIRMATION_STRATEGY_CHECKBOXES = [
    {
        checkboxKey: "confirmationEntropyRatioRegimeAlignment",
        inputKey: "confirmationEntropySlowWindow",
        strategyKey: "entropy_ratio_regime_alignment",
        paramKey: "slowWindow",
        defaultValue: 30,
        minValue: 2,
    },
    {
        checkboxKey: "confirmationCloseLocationMedianAlignment",
        inputKey: "confirmationCloseLocationLookback",
        strategyKey: "close_location_median_alignment",
        paramKey: "lookback",
        defaultValue: 63,
        minValue: 2,
    },
] as const;

function setDisabledState(
    inputs: ArrayLike<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    enabled: boolean
): void {
    for (let i = 0; i < inputs.length; i++) {
        inputs[i].disabled = !enabled;
    }
}

function setGroupDisabledState(groups: ArrayLike<HTMLElement>, enabled: boolean): void {
    for (let i = 0; i < groups.length; i++) {
        groups[i].classList.toggle('is-disabled', !enabled);
    }
}

function setSectionVisibility(section: HTMLElement | null, visible: boolean): void {
    if (!section) return;
    section.classList.toggle('is-hidden', !visible);
}

function setInteractiveSectionState(section: HTMLElement | null, enabled: boolean): void {
    if (!section) return;
    setSectionVisibility(section, enabled);
    setDisabledState(section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'), enabled);
    setGroupDisabledState(section.querySelectorAll<HTMLElement>('.param-group'), enabled);
}

function setInputGroupState(
    inputs: ArrayLike<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    enabled: boolean
): void {
    for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        input.disabled = !enabled;
        input.closest<HTMLElement>('.param-group')?.classList.toggle('is-disabled', !enabled);
    }
}

export function setupSettingsSections(dom: UiEventHandlersDom): void {
    const sectionFeatureBindings = {
        riskSettingsToggle: {
            toggle: dom.riskSettingsToggle,
            content: dom.riskSettings,
        },
        confirmationStrategiesToggle: {
            toggle: dom.confirmationStrategiesToggle,
            content: dom.confirmationStrategiesSettings,
        },
    } as const;

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        if (!sectionDef.featureToggleId || !sectionDef.featureContentId) return;

        const binding = sectionFeatureBindings[sectionDef.featureToggleId as keyof typeof sectionFeatureBindings];
        if (!binding) return;

        const applyState = () => {
            const enabled = binding.toggle.checked;
            binding.content.classList.toggle('is-hidden', !enabled);
            binding.content.toggleAttribute('inert', !enabled);
            binding.content.setAttribute('aria-hidden', enabled ? 'false' : 'true');
        };

        binding.toggle.addEventListener('change', applyState);
        applyState();
    });

    const riskModeSelect = dom.riskMode;
    const takeProfitModeSelect = dom.takeProfitMode;
    const riskSimpleAdvanced = dom.riskSimpleAdvanced;
    const riskPercentage = dom.riskPercentage;

    const riskPercentageGroups = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLElement>('.param-group')) : [];
    const riskPercentageInputs = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLInputElement>('input')) : [];
    const riskPercentageSelects = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLSelectElement>('select')) : [];
    const takeProfitModePanels = riskPercentage
        ? Array.from(riskPercentage.querySelectorAll<HTMLElement>('[data-tp-mode-panel]'))
        : [];
    const sharedTakeProfitFieldIds = [
        'takeProfitAdaptiveLookbackTrades',
        'takeProfitAdaptiveRecentWindow',
        'takeProfitAdaptiveMinMultiplier',
        'takeProfitAdaptiveMaxMultiplier',
        'takeProfitAdaptiveGridSteps',
        'takeProfitAdaptiveRegimeBlend',
        'takeProfitAdaptiveIcScale',
    ] as const;
    const syncSharedTakeProfitFields = () => {
        if (!riskPercentage) return;
        sharedTakeProfitFieldIds.forEach((fieldId) => {
            const canonical = document.getElementById(fieldId) as HTMLInputElement | HTMLSelectElement | null;
            if (!canonical) return;
            const mirrors = riskPercentage.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-shared-tp-field="${fieldId}"]`);
            mirrors.forEach((mirror) => {
                mirror.value = canonical.value;
                mirror.disabled = canonical.disabled;
            });
        });
    };
    const bindSharedTakeProfitFieldMirrors = () => {
        if (!riskPercentage) return;
        sharedTakeProfitFieldIds.forEach((fieldId) => {
            const canonical = document.getElementById(fieldId) as HTMLInputElement | HTMLSelectElement | null;
            if (!canonical) return;
            riskPercentage.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-shared-tp-field="${fieldId}"]`).forEach((mirror) => {
                mirror.addEventListener('input', () => {
                    canonical.value = mirror.value;
                    canonical.dispatchEvent(new Event('input', { bubbles: true }));
                });
                mirror.addEventListener('change', () => {
                    canonical.value = mirror.value;
                    canonical.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
        });
        syncSharedTakeProfitFields();
    };

    const applyTakeProfitMode = () => {
        const mode = takeProfitModeSelect.value;
        const activePanelId = TAKE_PROFIT_MODE_PANEL_IDS[mode as keyof typeof TAKE_PROFIT_MODE_PANEL_IDS] ?? null;
        takeProfitModePanels.forEach((panel) => {
            const panelMode = panel.dataset.tpModePanel;
            const shouldShow = panelMode === mode && (mode === 'mfe_bootstrap' || panel.id === activePanelId);
            setInteractiveSectionState(panel, shouldShow);
        });
        syncSharedTakeProfitFields();
    };

    const applyRiskMode = () => {
        const mode = riskModeSelect.value;
        const isPercentage = mode === 'percentage';

        if (riskSimpleAdvanced) {
            setSectionVisibility(riskSimpleAdvanced, !isPercentage);
        }
        if (riskPercentage) {
            setSectionVisibility(riskPercentage, isPercentage);
        }

        setGroupDisabledState(riskPercentageGroups, isPercentage);
        setDisabledState(riskPercentageInputs, isPercentage);
        setDisabledState(riskPercentageSelects, isPercentage);

        if (isPercentage) {
            applyTakeProfitMode();
        } else {
            takeProfitModePanels.forEach((panel) => {
                setInteractiveSectionState(panel, false);
            });
        }
    };

    riskModeSelect.addEventListener('change', applyRiskMode);
    takeProfitModeSelect.addEventListener('change', applyTakeProfitMode);
    bindSharedTakeProfitFieldMirrors();
    applyRiskMode();

    const tradeDirectionSelect = dom.tradeDirection;
    const flipLossStreakSettingsRow = dom.flipLossStreakSettingsRow;
    const flipLossStreakInputs = [
        dom.flipAfterConsecutiveLosses,
        dom.flipCooldownTrades,
        dom.minTradesBeforeFirstFlip,
    ];

    const applyTradeDirectionMode = () => {
        const isFlipLossMode = tradeDirectionSelect.value === 'both_flip_loss_2';
        setSectionVisibility(flipLossStreakSettingsRow, isFlipLossMode);
        setInputGroupState(flipLossStreakInputs, isFlipLossMode);
    };

    tradeDirectionSelect.addEventListener('change', applyTradeDirectionMode);
    applyTradeDirectionMode();

    const confirmationStrategiesInput = dom.confirmationStrategies;
    const confirmationStrategyParamsInput = dom.confirmationStrategyParams;
    const confirmationCheckboxes = CONFIRMATION_STRATEGY_CHECKBOXES.map((definition) => ({
        strategyKey: definition.strategyKey,
        paramKey: definition.paramKey,
        defaultValue: definition.defaultValue,
        minValue: definition.minValue,
        checkbox: dom[definition.checkboxKey],
        input: dom[definition.inputKey],
    }));
    const readConfirmationStrategyParams = (): Record<string, Record<string, number>> => {
        try {
            const parsed = JSON.parse(confirmationStrategyParamsInput.value || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

            const result: Record<string, Record<string, number>> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([strategyKey, rawParams]) => {
                if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return;
                const params: Record<string, number> = {};
                Object.entries(rawParams as Record<string, unknown>).forEach(([paramKey, rawValue]) => {
                    const parsedValue = parseInputNumber(String(rawValue));
                    if (typeof parsedValue === 'number' && Number.isFinite(parsedValue)) {
                        params[paramKey] = parsedValue;
                    }
                });
                if (Object.keys(params).length > 0) {
                    result[strategyKey] = params;
                }
            });
            return result;
        } catch {
            return {};
        }
    };
    const readConfirmationStrategies = () => new Set(
        confirmationStrategiesInput.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
    );
    const syncConfirmationCheckboxesFromInput = () => {
        const selected = readConfirmationStrategies();
        confirmationCheckboxes.forEach(({ strategyKey, checkbox }) => {
            checkbox.checked = selected.has(strategyKey);
        });
        applyConfirmationParameterState();
    };
    const syncConfirmationInputFromCheckboxes = () => {
        confirmationStrategiesInput.value = confirmationCheckboxes
            .filter(({ checkbox }) => checkbox.checked)
            .map(({ strategyKey }) => strategyKey)
            .join(',');
        applyConfirmationParameterState();
    };
    const syncConfirmationParamsFromInput = () => {
        const paramsByStrategy = readConfirmationStrategyParams();
        confirmationCheckboxes.forEach(({ strategyKey, paramKey, defaultValue, input }) => {
            const rawValue = paramsByStrategy[strategyKey]?.[paramKey];
            input.value = String(Number.isFinite(rawValue) ? rawValue : defaultValue);
        });
        applyConfirmationParameterState();
    };
    const syncConfirmationParamsInputFromFields = () => {
        const paramsByStrategy: Record<string, Record<string, number>> = {};
        confirmationCheckboxes.forEach(({ strategyKey, paramKey, defaultValue, minValue, input }) => {
            const parsedValue = parseInputNumber(input.value);
            const value = typeof parsedValue === 'number' && Number.isFinite(parsedValue)
                ? Math.max(minValue, Math.round(parsedValue))
                : defaultValue;
            paramsByStrategy[strategyKey] = { [paramKey]: value };
        });
        confirmationStrategyParamsInput.value = JSON.stringify(paramsByStrategy);
    };
    function applyConfirmationParameterState(): void {
        confirmationCheckboxes.forEach(({ checkbox, input }) => {
            input.disabled = !checkbox.checked;
        });
    }

    confirmationCheckboxes.forEach(({ checkbox }) => {
        checkbox.addEventListener('change', syncConfirmationInputFromCheckboxes);
    });
    confirmationCheckboxes.forEach(({ input }) => {
        input.addEventListener('input', syncConfirmationParamsInputFromFields);
        input.addEventListener('change', syncConfirmationParamsInputFromFields);
    });
    confirmationStrategiesInput.addEventListener('change', syncConfirmationCheckboxesFromInput);
    confirmationStrategiesInput.addEventListener('input', syncConfirmationCheckboxesFromInput);
    confirmationStrategyParamsInput.addEventListener('change', syncConfirmationParamsFromInput);
    confirmationStrategyParamsInput.addEventListener('input', syncConfirmationParamsFromInput);
    syncConfirmationCheckboxesFromInput();
    syncConfirmationParamsFromInput();
    syncConfirmationParamsInputFromFields();

    const strategyTimeframeToggle = dom.strategyTimeframeToggle;
    const strategyTimeframeMinutes = dom.strategyTimeframeMinutes;
    const strategyTimeframeMinutesGroup = dom.strategyTimeframeMinutesGroup;
    const syncStrategyTimeframeState = () => {
        const parsedMinutes = parseInputNumber(strategyTimeframeMinutes.value);
        setStrategyTimeframeSettings({
            enabled: strategyTimeframeToggle.checked,
            minutes: typeof parsedMinutes === 'number' && Number.isFinite(parsedMinutes)
                ? Math.max(1, Math.floor(parsedMinutes))
                : 120,
        });
    };

    const applyStrategyTimeframeMode = () => {
        const enabled = strategyTimeframeToggle.checked;
        strategyTimeframeMinutes.disabled = !enabled;
        if (strategyTimeframeMinutesGroup) {
            strategyTimeframeMinutesGroup.classList.toggle('is-disabled', !enabled);
        }
        syncStrategyTimeframeState();
    };

    strategyTimeframeToggle.addEventListener('change', applyStrategyTimeframeMode);
    strategyTimeframeMinutes.addEventListener('input', syncStrategyTimeframeState);
    strategyTimeframeMinutes.addEventListener('change', syncStrategyTimeframeState);
    applyStrategyTimeframeMode();

    const fixedTradeToggle = dom.fixedTradeToggle;
    const initialCapitalGroup = dom.initialCapitalGroup;
    const fixedTradeGroup = dom.fixedTradeGroup;
    const tradeSizingModeGroup = dom.tradeSizingModeGroup;
    const positionSizeGroup = dom.positionSizeGroup;
    const initialCapitalInput = dom.initialCapital;
    const tradeSizingModeInput = dom.tradeSizingMode;
    const fixedTradeAmountInput = dom.fixedTradeAmount;
    const positionSizeInput = dom.positionSize;
    const advancedSizingPanel = dom.advancedSizingSettingsPanel;
    const martingaleBaseSizeInput = dom.martingaleBaseSize;
    const advancedSizingSubsections = [
        dom.kellySettings,
        dom.volatilityTargetingSettings,
        dom.riskParitySettings,
        dom.martingaleSettings,
        dom.optimalFSettings,
    ];

    const applyTradeSizingMode = () => {
        const useAlternativeSizing = fixedTradeToggle.checked;
        const selectedMode = useAlternativeSizing ? tradeSizingModeInput.value : 'percent';
        const usesDirectFractionSizing = selectedMode === 'kelly_criterion'
            || selectedMode === 'optimal_f'
            || selectedMode === 'secure_f';
        const usesPercentBase = useAlternativeSizing
            && (selectedMode === 'martingale' || selectedMode === 'anti_martingale')
            && martingaleBaseSizeInput.value === 'percent';

        initialCapitalGroup.classList.toggle('is-hidden', false);
        fixedTradeGroup.classList.toggle('is-hidden', !useAlternativeSizing || usesDirectFractionSizing || usesPercentBase);
        tradeSizingModeGroup.classList.toggle('is-hidden', !useAlternativeSizing);
        positionSizeGroup.classList.toggle('is-hidden', useAlternativeSizing && !usesPercentBase);

        initialCapitalInput.disabled = false;
        tradeSizingModeInput.disabled = !useAlternativeSizing;
        fixedTradeAmountInput.disabled = !useAlternativeSizing || usesDirectFractionSizing || usesPercentBase;
        positionSizeInput.disabled = useAlternativeSizing && !usesPercentBase;

        const activeSubsectionId = ADVANCED_SIZING_SUBSECTION_IDS[selectedMode as keyof typeof ADVANCED_SIZING_SUBSECTION_IDS];
        const hasAdvancedPanel = useAlternativeSizing && Boolean(activeSubsectionId);
        advancedSizingPanel.classList.toggle('is-hidden', !hasAdvancedPanel);

        advancedSizingSubsections.forEach((section) => {
            section.classList.toggle('is-hidden', !hasAdvancedPanel || section.id !== activeSubsectionId);
        });
    };

    fixedTradeToggle.addEventListener('change', applyTradeSizingMode);
    tradeSizingModeInput.addEventListener('change', applyTradeSizingMode);
    martingaleBaseSizeInput.addEventListener('change', applyTradeSizingMode);
    applyTradeSizingMode();
}
