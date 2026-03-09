/**
 * Settings UX Enhancements
 *
 * 1. Collapsible accordion sections
 * 2. Preset mode selector (Simple / Standard / Advanced)
 * 3. Info-icon tooltips converting inline .param-hint text
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

function initAccordion(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    const applyAccordionState = (header: HTMLElement, body: HTMLElement): void => {
        const expanded = !header.classList.contains('collapsed');
        header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        body.setAttribute('aria-hidden', expanded ? 'false' : 'true');
        body.toggleAttribute('inert', !expanded);
    };

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

function initPresets(): void {
    const settingsTab = document.getElementById('settingsTab');
    const presetBar = document.getElementById('settingsPresetBar');
    if (!settingsTab || !presetBar) return;

    const savedPreset = localStorage.getItem(PRESET_STORAGE_KEY) as SettingsPresetMode | null;
    const initialPreset: SettingsPresetMode = savedPreset && ['simple', 'standard', 'advanced'].includes(savedPreset)
        ? savedPreset
        : 'standard';

    applyPreset(initialPreset, settingsTab, presetBar);

    presetBar.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('.settings-preset-btn');
        if (!button) return;

        const preset = button.dataset.preset as SettingsPresetMode;
        if (!preset) return;

        applyPreset(preset, settingsTab, presetBar);
        localStorage.setItem(PRESET_STORAGE_KEY, preset);
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

function initTooltips(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    settingsTab.classList.add('tooltips-active');

    const hints = settingsTab.querySelectorAll<HTMLElement>('.param-hint');

    hints.forEach((hint) => {
        const text = hint.textContent?.trim();
        if (!text) return;

        const paramGroup = hint.closest('.param-group');
        if (!paramGroup) return;

        const label = paramGroup.querySelector<HTMLElement>('.param-label');
        if (!label || label.querySelector('.info-tip-trigger')) return;

        const tipTrigger = document.createElement('span');
        tipTrigger.className = 'info-tip-trigger';
        tipTrigger.setAttribute('tabindex', '0');
        tipTrigger.setAttribute('role', 'button');
        tipTrigger.setAttribute('aria-label', text);
        tipTrigger.innerHTML = `â“˜<span class="info-tip-content">${escapeHTML(text)}</span>`;

        if (!label.classList.contains('param-label-with-tip')) {
            label.classList.add('param-label-with-tip');
        }
        label.appendChild(tipTrigger);
    });
}

function escapeHTML(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function syncRegistryMarkup(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        const section = settingsTab.querySelector<HTMLElement>(`.settings-section[data-section="${sectionDef.id}"]`);
        if (!section) return;

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
    initAccordion();
    initPresets();
    initTooltips();
    bindFormAccessibility(document);
}
