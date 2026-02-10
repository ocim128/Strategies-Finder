/**
 * Settings UX Enhancements
 * 
 * 1. Collapsible accordion sections
 * 2. Preset mode selector (Simple / Standard / Advanced)
 * 3. Info-icon tooltips converting inline .param-hint text
 * 
 * Call `initSettingsUX()` once after the DOM (settings tab HTML) is loaded.
 */

import { debugLogger } from '../debug-logger';

// ============================================================================
// Types
// ============================================================================

type PresetMode = 'simple' | 'standard' | 'advanced';

const PRESET_STORAGE_KEY = 'playground_settings_preset';

// ============================================================================
// 1. Accordion Collapse
// ============================================================================

function initAccordion(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    const headers = settingsTab.querySelectorAll<HTMLElement>('.section-header.collapsible');

    headers.forEach(header => {
        header.addEventListener('click', (e) => {
            // Don't toggle if they clicked the section-toggle (checkbox)
            const target = e.target as HTMLElement;
            if (target.closest('.section-toggle')) return;

            const targetId = header.dataset.target;
            if (!targetId) return;

            const body = document.getElementById(targetId);
            if (!body) return;

            const isCollapsed = header.classList.contains('collapsed');

            if (isCollapsed) {
                // Expand
                header.classList.remove('collapsed');
                body.classList.remove('collapsed');
            } else {
                // Collapse
                header.classList.add('collapsed');
                body.classList.add('collapsed');
            }
        });
    });
}

// ============================================================================
// 2. Preset Mode Selector
// ============================================================================

function initPresets(): void {
    const settingsTab = document.getElementById('settingsTab');
    const presetBar = document.getElementById('settingsPresetBar');
    if (!settingsTab || !presetBar) return;

    // Load saved preset
    const savedPreset = localStorage.getItem(PRESET_STORAGE_KEY) as PresetMode | null;
    const initialPreset: PresetMode = savedPreset && ['simple', 'standard', 'advanced'].includes(savedPreset)
        ? savedPreset
        : 'standard';

    applyPreset(initialPreset, settingsTab, presetBar);

    // Button click handlers
    presetBar.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.settings-preset-btn');
        if (!btn) return;

        const preset = btn.dataset.preset as PresetMode;
        if (!preset) return;

        applyPreset(preset, settingsTab, presetBar);
        localStorage.setItem(PRESET_STORAGE_KEY, preset);
        debugLogger.event('ui.settings.preset', { preset });
    });
}

function applyPreset(preset: PresetMode, settingsTab: HTMLElement, presetBar: HTMLElement): void {
    // Update data attribute for CSS-driven visibility
    settingsTab.dataset.preset = preset;

    // Update active button
    presetBar.querySelectorAll('.settings-preset-btn').forEach(btn => {
        btn.classList.toggle('active', (btn as HTMLElement).dataset.preset === preset);
    });

    // Auto-expand sections that become visible, auto-collapse hidden ones
    const sections = settingsTab.querySelectorAll<HTMLElement>('.settings-section');
    sections.forEach(section => {
        const complexity = section.dataset.complexity || 'simple';
        const isVisible = isSectionVisibleForPreset(complexity, preset);

        // If a section just became visible and was collapsed, keep it as-is
        // If a section is being hidden, no special action needed (CSS handles display:none)
        if (!isVisible) return;

        // For sections that are visible in this preset and were previously hidden,
        // make sure the header/body state is consistent
        const header = section.querySelector<HTMLElement>('.section-header.collapsible');
        const targetId = header?.dataset.target;
        if (header && targetId) {
            const body = document.getElementById(targetId);
            // The section-toggle (on/off toggle for the feature) drives section-body visibility
            // via `is-hidden`. The accordion only controls collapsed/expanded within that.
            // No auto-expand needed; respect user's accordion state.
            if (body) {
                // nothing to force here. The accordion state is preserved.
            }
        }
    });
}

function isSectionVisibleForPreset(complexity: string, preset: PresetMode): boolean {
    if (preset === 'advanced') return true;
    if (preset === 'standard') return complexity !== 'advanced';
    // simple
    return complexity === 'simple';
}

// ============================================================================
// 3. Info-icon Tooltips
// ============================================================================

function initTooltips(): void {
    const settingsTab = document.getElementById('settingsTab');
    if (!settingsTab) return;

    // Add the tooltips-active class to enable CSS hiding of .param-hint
    settingsTab.classList.add('tooltips-active');

    // Find all .param-hint elements and convert them
    const hints = settingsTab.querySelectorAll<HTMLElement>('.param-hint');

    hints.forEach(hint => {
        const text = hint.textContent?.trim();
        if (!text) return;

        // Find the closest param-label sibling (walk up to param-group, find label)
        const paramGroup = hint.closest('.param-group');
        if (!paramGroup) return;

        const label = paramGroup.querySelector<HTMLElement>('.param-label');
        if (!label) return;

        // Skip if already has a tooltip
        if (label.querySelector('.info-tip-trigger')) return;

        // Create the info icon with tooltip
        const tipTrigger = document.createElement('span');
        tipTrigger.className = 'info-tip-trigger';
        tipTrigger.setAttribute('tabindex', '0');
        tipTrigger.setAttribute('role', 'button');
        tipTrigger.setAttribute('aria-label', text);
        tipTrigger.innerHTML = `ⓘ<span class="info-tip-content">${escapeHTML(text)}</span>`;

        // Wrap label text + icon
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

// ============================================================================
// Public Init
// ============================================================================

export function initSettingsUX(): void {
    initAccordion();
    initPresets();
    initTooltips();
}
