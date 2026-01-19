import { settingsManager } from "../settingsManager";
import { uiManager } from "../uiManager";
import { debugLogger } from "../debugLogger";

export function setupSettingsHandlers() {
    // Reset to Default button
    const resetBtn = document.getElementById('resetSettingsBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('Reset all settings to default values?')) {
                settingsManager.resetToDefault();
                uiManager.showToast('Settings reset to default', 'info');
                debugLogger.event('ui.settings.reset');
            }
        });
    }

    // Save Configuration logic
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const configNameInput = document.getElementById('configNameInput') as HTMLInputElement | null;

    const performSave = () => {
        if (!configNameInput) return;

        console.log('[UI] Save Config Triggered');
        try {
            const name = configNameInput.value.trim();
            if (!name) {
                uiManager.showToast('Please enter a configuration name', 'error');
                configNameInput.focus();
                return;
            }

            console.log('[UI] Saving config:', name);
            settingsManager.saveStrategyConfig(name);

            // Update dropdown and select the new config
            updateConfigDropdown(name);

            configNameInput.value = '';
            uiManager.showToast(`Configuration "${name}" saved`, 'success');
            debugLogger.event('ui.config.saved', { name });

            // Visual feedback on the button
            if (saveConfigBtn) {
                saveConfigBtn.classList.add('btn-pulse-success');
                setTimeout(() => saveConfigBtn.classList.remove('btn-pulse-success'), 1000);
            }
        } catch (error) {
            console.error('[UI] Save Config Error:', error);
            uiManager.showToast('Failed to save configuration', 'error');
        }
    };

    if (saveConfigBtn && configNameInput) {
        saveConfigBtn.addEventListener('click', performSave);

        // Add Enter key support
        configNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSave();
            }
        });
    }

    // Load Configuration button
    const loadConfigBtn = document.getElementById('loadConfigBtn');
    const configSelect = document.getElementById('configSelect') as HTMLSelectElement | null;
    if (loadConfigBtn && configSelect) {
        loadConfigBtn.addEventListener('click', () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to load', 'error');
                return;
            }
            const config = settingsManager.loadStrategyConfig(name);
            if (config) {
                settingsManager.applyStrategyConfig(config);
                uiManager.showToast(`Configuration "${name}" loaded`, 'success');
                debugLogger.event('ui.config.loaded', { name });
            }
        });
    }

    // Delete Configuration button
    const deleteConfigBtn = document.getElementById('deleteConfigBtn');
    if (deleteConfigBtn && configSelect) {
        deleteConfigBtn.addEventListener('click', () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to delete', 'error');
                return;
            }
            if (confirm(`Delete configuration "${name}"?`)) {
                settingsManager.deleteStrategyConfig(name);
                updateConfigDropdown();
                uiManager.showToast(`Configuration "${name}" deleted`, 'info');
                debugLogger.event('ui.config.deleted', { name });
            }
        });
    }

    // Initialize dropdown with saved configs
    updateConfigDropdown();
}

/**
 * Updates the configuration dropdown list from localStorage.
 * @param selectName Optional name of the configuration to select after updating.
 */
export function updateConfigDropdown(selectName?: string) {
    const configSelect = document.getElementById('configSelect') as HTMLSelectElement | null;
    if (!configSelect) return;

    const configs = settingsManager.loadAllStrategyConfigs();
    const currentValue = selectName || configSelect.value;

    // Clear existing options
    configSelect.innerHTML = '<option value="">-- Select configuration --</option>';

    // Add saved configurations
    configs.forEach(config => {
        const option = document.createElement('option');
        option.value = config.name;
        option.textContent = `${config.name} (${config.strategyKey})`;
        configSelect.appendChild(option);
    });

    // Restore selection if still valid or specifically requested
    if (currentValue && configs.some(c => c.name === currentValue)) {
        configSelect.value = currentValue;
    }
}
