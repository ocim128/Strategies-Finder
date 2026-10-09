/**
 * Settings UX Enhancements
 *
 * 1. Collapsible accordion sections
 * 2. Preset mode selector (Simple / Standard)
 */

import { debugLogger } from '../debug-logger';
import { bindFormAccessibility } from '../form-accessibility';
import { createSettingsWorkspaceDom } from '../ui-manager-dom';
import { initSettingsWorkspace } from './settings-workspace';
import {
    STRATEGY_PANEL_SETTINGS_SECTIONS,
    type SettingsPresetMode,
} from '../strategy-panel-settings-registry';

const PRESET_STORAGE_KEY = 'playground_settings_preset';
const VALID_PRESETS = ['simple', 'standard'] as const;

function isSettingsPresetMode(value: string | null | undefined): value is SettingsPresetMode {
    return !!value && VALID_PRESETS.includes(value as SettingsPresetMode);
}

function readSavedPreset(): SettingsPresetMode | null {
    try {
        const saved = localStorage.getItem(PRESET_STORAGE_KEY);
        const preset = saved === 'advanced' ? 'standard' : saved;
        if (!isSettingsPresetMode(preset)) return null;
        return preset;
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

function initPresets(): void {
    const { settingsTab } = createSettingsWorkspaceDom();
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

        section.hidden = preset === 'simple' && sectionDef.preset === 'standard';
    });
}

export function initSettingsUX(): void {
    initPresets();
    bindFormAccessibility(document);
    initSettingsWorkspace(createSettingsWorkspaceDom());
}
