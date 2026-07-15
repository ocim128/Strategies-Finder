/**
 * Settings UX Enhancements
 *
 * 1. Collapsible accordion sections
 * 2. Preset mode selector (Simple / Standard)
 */

import { debugLogger } from '../debug-logger';
import { bindFormAccessibility } from '../form-accessibility';
import {
    STRATEGY_PANEL_SETTINGS_SECTIONS,
    type SettingsPresetMode,
    getSettingsSectionDefinition,
    isSettingsSectionVisibleForPreset,
} from '../strategy-panel-settings-registry';

const PRESET_STORAGE_KEY = 'playground_settings_preset';
const VALID_PRESETS = ['simple', 'standard', 'advanced'] as const;

function isSettingsPresetMode(value: string | null | undefined): value is SettingsPresetMode {
    return !!value && VALID_PRESETS.includes(value as SettingsPresetMode);
}

function readSavedPreset(): SettingsPresetMode | null {
    try {
        const preset = localStorage.getItem(PRESET_STORAGE_KEY);
        if (!isSettingsPresetMode(preset)) return null;
        // "advanced" was removed from the UI (no sections used it). Treat any
        // saved "advanced" as "standard" so old payloads still apply cleanly.
        return preset === 'advanced' ? 'standard' : preset;
    } catch {
        return null;
    }
}

function writeSavedPreset(preset: SettingsPresetMode): void {
    try {
        localStorage.setItem(PRESET_STORAGE_KEY, preset);
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
}

function applyAccordionState(header: HTMLElement, body: HTMLElement): void {
    const expanded = !header.classList.contains('collapsed');
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    body.toggleAttribute('inert', !expanded);
}

function initAccordion(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        const section = settingsTab.querySelector<HTMLElement>(`.settings-section[data-section="${sectionDef.id}"]`);
        const header = section?.querySelector<HTMLElement>('.section-header.collapsible');
        if (!section || !header) {
            return;
        }

        const targetId = sectionDef.accordionBodyId;
        const body = document.getElementById(targetId);
        header.dataset.target = targetId;
        header.setAttribute('role', 'button');
        header.tabIndex = 0;
        header.setAttribute('aria-controls', targetId);

        if (body) {
            applyAccordionState(header, body);
        }

        const toggleSection = () => {
            const sectionBody = document.getElementById(targetId);
            if (!sectionBody) return;

            const isCollapsed = header.classList.contains('collapsed');
            header.classList.toggle('collapsed', !isCollapsed);
            sectionBody.classList.toggle('collapsed', !isCollapsed);
            applyAccordionState(header, sectionBody);
        };

        header.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            if (target.closest('.section-toggle')) return;
            toggleSection();
        });

        header.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target as HTMLElement;
            if (target.closest('.section-toggle')) return;
            event.preventDefault();
            toggleSection();
        });
    });
}

function initWorkspaceAccordion(): void {
    const header = document.getElementById('strategyWorkspaceToggle');
    const body = document.getElementById('strategyWorkspaceBody');
    // The outer workspace accordion was flattened (F7): the toggle element is
    // kept in the DOM for contract stability but is `hidden`, and the body is
    // always visible. Skip wiring the accordion behavior in that case.
    if (!header || !body || header.hasAttribute('hidden')) return;

    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.setAttribute('aria-controls', body.id);
    applyAccordionState(header, body);

    const toggleWorkspace = (): void => {
        const isCollapsed = header.classList.contains('collapsed');
        header.classList.toggle('collapsed', !isCollapsed);
        body.classList.toggle('collapsed', !isCollapsed);
        applyAccordionState(header, body);
    };

    header.addEventListener('click', toggleWorkspace);
    header.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleWorkspace();
    });
}

function initPresets(): void {
    const settingsTab = document.getElementById('settingsTab');
    const presetBar = document.getElementById('settingsPresetBar');
    if (!settingsTab || !presetBar) return;

    const initialPreset: SettingsPresetMode = readSavedPreset() ?? 'standard';

    applyPreset(initialPreset, settingsTab, presetBar);

    presetBar.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('.settings-preset-btn');
        if (!button) return;

        const preset = button.dataset.preset;
        if (!isSettingsPresetMode(preset)) return;

        applyPreset(preset, settingsTab, presetBar);
        writeSavedPreset(preset);
        debugLogger.event('ui.settings.preset', { preset });
    });
}

function applyPreset(preset: SettingsPresetMode, settingsTab: HTMLElement, presetBar: HTMLElement): void {
    settingsTab.dataset.preset = preset;

    presetBar.querySelectorAll('.settings-preset-btn').forEach((button) => {
        button.classList.toggle('active', (button as HTMLElement).dataset.preset === preset);
    });

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        const section = settingsTab.querySelector<HTMLElement>(`.settings-section[data-section="${sectionDef.id}"]`);
        if (!section) return;

        section.hidden = !isSettingsSectionVisibleForPreset(sectionDef.preset, preset);
    });
}

function syncRegistryMarkup(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    const sectionsContainer = document.getElementById('strategyWorkspaceSections');
    const firstFooterElement = Array.from(sectionsContainer?.children ?? [])
        .find((child) => !(child as HTMLElement).classList.contains('settings-section')) ?? null;

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        const section = settingsTab.querySelector<HTMLElement>(`.settings-section[data-section="${sectionDef.id}"]`);
        if (!section) return;

        sectionsContainer?.insertBefore(section, firstFooterElement);
        section.dataset.complexity = sectionDef.preset;

        const header = section.querySelector<HTMLElement>('.section-header.collapsible');
        if (header) {
            header.dataset.target = sectionDef.accordionBodyId;
        }
    });

    const headers = settingsTab.querySelectorAll<HTMLElement>('.settings-section .section-header.collapsible');
    headers.forEach((header) => {
        const sectionId = header.closest<HTMLElement>('.settings-section')?.dataset.section;
        if (!sectionId) return;

        const sectionDef = getSettingsSectionDefinition(sectionId);
        if (!sectionDef) return;

        header.dataset.target = sectionDef.accordionBodyId;
    });
}

export function initSettingsUX(): void {
    syncRegistryMarkup();
    initWorkspaceAccordion();
    initAccordion();
    initPresets();
    bindFormAccessibility(document);
}
