// ═══════════════════════════════════════════════════════════════════════════
// Strategy Combiner - UI Manager
// ═══════════════════════════════════════════════════════════════════════════

import { getStrategyList, strategyRegistry } from '../strategyRegistry';
import { uiManager } from './uiManager';
import { settingsManager } from './settingsManager';
import {
    CombinedStrategyDefinition,
    StrategyMetadata,
    LogicOperator,
    ConflictResolution,
    listCombinedStrategies,
    saveCombinedStrategy,
    deleteCombinedStrategy,
    loadCombinedStrategy,
    createEmptyDefinition,
    createStrategyMetadata,
    createStrategyNode,
    createOperatorNode,
    validateDefinition,
    toExecutableStrategy,
    exportToFile,
} from './strategies/combiner';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

interface CombinerState {
    isEditing: boolean;
    currentDefinition: CombinedStrategyDefinition | null;
    selectedStrategies: StrategyMetadata[];
}

const state: CombinerState = {
    isEditing: false,
    currentDefinition: null,
    selectedStrategies: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getEl<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER SAVED LIST
// ═══════════════════════════════════════════════════════════════════════════

function renderCombinedList(): void {
    const container = getEl('combinerList');
    const emptyState = getEl('combinerEmpty');
    if (!container) return;

    const definitions = listCombinedStrategies();

    if (definitions.length === 0) {
        if (emptyState) emptyState.classList.remove('is-hidden');
        container.innerHTML = '';
        container.appendChild(emptyState!);
        return;
    }

    if (emptyState) emptyState.classList.add('is-hidden');

    container.innerHTML = definitions.map(def => `
        <div class="combiner-item" data-id="${def.id}">
            <div class="combiner-item-info">
                <div class="combiner-item-name">${escapeHtml(def.name)}</div>
                <div class="combiner-item-meta">
                    <span>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                        </svg>
                        ${def.inputStrategies.length} strategies
                    </span>
                    <span>${getOperatorLabel(def)}</span>
                    ${def.shortHandling.enabled ? '<span class="operator-badge">SHORT</span>' : ''}
                </div>
            </div>
            <div class="combiner-item-actions">
                <button class="btn btn-secondary btn-compact combiner-edit-btn" data-id="${def.id}" title="Edit">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                    </svg>
                </button>
                <button class="btn btn-primary btn-compact combiner-run-btn" data-id="${def.id}" title="Run Backtest">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
                <button class="btn btn-secondary btn-compact combiner-export-btn" data-id="${def.id}" title="Export">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                </button>
                <button class="btn btn-danger btn-compact combiner-delete-btn" data-id="${def.id}" title="Delete">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    // Add event listeners
    container.querySelectorAll('.combiner-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editCombination(btn.getAttribute('data-id')!));
    });

    container.querySelectorAll('.combiner-run-btn').forEach(btn => {
        btn.addEventListener('click', () => runCombination(btn.getAttribute('data-id')!));
    });

    container.querySelectorAll('.combiner-export-btn').forEach(btn => {
        btn.addEventListener('click', () => exportCombination(btn.getAttribute('data-id')!));
    });

    container.querySelectorAll('.combiner-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteCombination(btn.getAttribute('data-id')!));
    });
}

function getOperatorLabel(def: CombinedStrategyDefinition): string {
    const node = def.executionRules.openCondition;
    if (node.type === 'operator' && node.operator) {
        return `<span class="operator-badge ${node.operator.toLowerCase()}">${node.operator}</span>`;
    }
    return '';
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILDER PANEL
// ═══════════════════════════════════════════════════════════════════════════

function showBuilder(definition?: CombinedStrategyDefinition): void {
    const builder = getEl('combinerBuilder');
    if (!builder) return;

    state.isEditing = !!definition;
    state.currentDefinition = definition || createEmptyDefinition('New Combination');
    state.selectedStrategies = definition?.inputStrategies || [];

    // Populate fields
    const nameInput = getEl<HTMLInputElement>('combinerName');
    const descInput = getEl<HTMLInputElement>('combinerDescription');
    if (nameInput) nameInput.value = state.currentDefinition.name;
    if (descInput) descInput.value = state.currentDefinition.description || '';

    // Populate strategy slots
    renderStrategySlots();

    // Set operator
    const operatorSelect = getEl<HTMLSelectElement>('combinerOpenOperator');
    if (operatorSelect && state.currentDefinition.executionRules.openCondition.operator) {
        operatorSelect.value = state.currentDefinition.executionRules.openCondition.operator;
    }

    // Set conflict resolution
    const conflictSelect = getEl<HTMLSelectElement>('combinerConflictResolution');
    if (conflictSelect) {
        conflictSelect.value = state.currentDefinition.executionRules.conflictResolution;
        togglePrimaryStrategy(conflictSelect.value);
    }

    // Set primary strategy
    const primarySelect = getEl<HTMLSelectElement>('combinerPrimaryStrategy');
    if (primarySelect && state.currentDefinition.executionRules.primaryStrategyId) {
        // Find index of primary strategy
        const primaryId = state.currentDefinition.executionRules.primaryStrategyId;
        const idx = state.selectedStrategies.findIndex(s => s.id === primaryId);
        if (idx >= 0) primarySelect.value = idx.toString();
    }

    // Set close toggle and strategy
    const closeToggle = getEl<HTMLInputElement>('combinerCloseToggle');
    const closeSelect = getEl<HTMLSelectElement>('combinerCloseStrategy');
    if (closeToggle) {
        const hasClose = !!state.currentDefinition.executionRules.closeCondition;
        closeToggle.checked = hasClose;
        toggleCloseSettings(hasClose);

        if (hasClose && closeSelect) {
            const firstOperand = state.currentDefinition.executionRules.closeCondition?.operands?.[0];
            if (firstOperand?.type === 'strategy' && firstOperand.strategyRef) {
                // Find index by exact match of metadata (including configName/params)
                const meta = firstOperand.strategyRef;
                const idx = state.selectedStrategies.findIndex(s =>
                    s.strategyId === meta.strategyId &&
                    s.configName === meta.configName &&
                    JSON.stringify(s.params) === JSON.stringify(meta.params)
                );
                if (idx >= 0) closeSelect.value = idx.toString();
            }
        }
    }

    // Set short toggle and logic
    const shortToggle = getEl<HTMLInputElement>('combinerShortToggle');
    const shortLogicSelect = getEl<HTMLSelectElement>('combinerShortLogic');
    const shortStrategySelect = getEl<HTMLSelectElement>('combinerShortStrategy');

    if (shortToggle) {
        shortToggle.checked = state.currentDefinition.shortHandling.enabled;
        toggleShortSettings(shortToggle.checked);

        if (state.currentDefinition.shortHandling.enabled && shortLogicSelect) {
            const isIndependent = !!state.currentDefinition.shortHandling.shortLogic;
            shortLogicSelect.value = isIndependent ? 'independent' : 'invert';
            toggleShortStrategyGroup(isIndependent);

            if (isIndependent && shortStrategySelect) {
                const firstOperand = state.currentDefinition.shortHandling.shortLogic?.operands?.[0];
                if (firstOperand?.type === 'strategy' && firstOperand.strategyRef) {
                    // Find index by exact match of metadata
                    const meta = firstOperand.strategyRef;
                    const idx = state.selectedStrategies.findIndex(s =>
                        s.strategyId === meta.strategyId &&
                        s.configName === meta.configName &&
                        JSON.stringify(s.params) === JSON.stringify(meta.params)
                    );
                    if (idx >= 0) shortStrategySelect.value = idx.toString();
                }
            }
        }
    }

    // Show builder
    builder.classList.remove('is-hidden');
    updateValidation();
}

function hideBuilder(): void {
    const builder = getEl('combinerBuilder');
    if (builder) builder.classList.add('is-hidden');
    state.currentDefinition = null;
    state.selectedStrategies = [];
}

function getStrategyOptionsHtml(selectedId?: string, selectedConfigName?: string): string {
    const strategies = getStrategyList();
    const configs = settingsManager.loadAllStrategyConfigs();

    let html = '<optgroup label="Base Strategies">';
    html += strategies.map(s => {
        const value = s.key;
        const isSelected = !selectedConfigName && value === selectedId;
        return `<option value="${value}" ${isSelected ? 'selected' : ''}>${s.name}</option>`;
    }).join('');
    html += '</optgroup>';

    if (configs.length > 0) {
        html += '<optgroup label="Saved Configurations">';
        html += configs.map(c => {
            const value = `config:${c.name}`;
            const isSelected = selectedConfigName === c.name;
            return `<option value="${value}" ${isSelected ? 'selected' : ''}>${c.name} (${c.strategyKey})</option>`;
        }).join('');
        html += '</optgroup>';
    }

    return html;
}

function renderStrategySlots(): void {
    const container = getEl('combinerStrategies');
    if (!container) return;

    container.innerHTML = state.selectedStrategies.map((meta, index) => `
        <div class="combiner-strategy-slot" data-index="${index}">
            <select class="param-input strategy-select-slot" data-index="${index}" title="Select Strategy">
                ${getStrategyOptionsHtml(meta.strategyId, meta.configName)}
            </select>
            
            <select class="timeframe-select" data-index="${index}" title="Timeframe">
                <option value="" ${!meta.timeframe ? 'selected' : ''}>Default (Chart)</option>
                <option value="1m" ${meta.timeframe === '1m' ? 'selected' : ''}>1m</option>
                <option value="3m" ${meta.timeframe === '3m' ? 'selected' : ''}>3m</option>
                <option value="5m" ${meta.timeframe === '5m' ? 'selected' : ''}>5m</option>
                <option value="15m" ${meta.timeframe === '15m' ? 'selected' : ''}>15m</option>
                <option value="30m" ${meta.timeframe === '30m' ? 'selected' : ''}>30m</option>
                <option value="1h" ${meta.timeframe === '1h' ? 'selected' : ''}>1h</option>
                <option value="4h" ${meta.timeframe === '4h' ? 'selected' : ''}>4h</option>
                <option value="1d" ${meta.timeframe === '1d' ? 'selected' : ''}>1d</option>
                <option value="1w" ${meta.timeframe === '1w' ? 'selected' : ''}>1w</option>
            </select>

            <select class="role-select" data-index="${index}" title="Role">
                <option value="entry" ${meta.role === 'entry' ? 'selected' : ''}>Entry</option>
                <option value="filter" ${meta.role === 'filter' ? 'selected' : ''}>Filter</option>
                <option value="exit" ${meta.role === 'exit' ? 'selected' : ''}>Exit</option>
                <option value="regime" ${meta.role === 'regime' ? 'selected' : ''}>Regime</option>
            </select>

            <button class="combiner-remove-slot" data-index="${index}" title="Remove">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
            </button>
        </div>
    `).join('');

    // Add event listeners
    container.querySelectorAll('.strategy-select-slot').forEach(select => {
        select.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            const index = parseInt(target.getAttribute('data-index')!);
            const value = target.value;

            if (value.startsWith('config:')) {
                const configName = value.replace('config:', '');
                const config = settingsManager.loadStrategyConfig(configName);
                if (config) {
                    state.selectedStrategies[index].strategyId = config.strategyKey;
                    state.selectedStrategies[index].params = config.strategyParams;
                    state.selectedStrategies[index].configName = config.name;
                }
            } else {
                state.selectedStrategies[index].strategyId = value;
                state.selectedStrategies[index].params = undefined;
                state.selectedStrategies[index].configName = undefined;
            }

            updateValidation();
            updatePrimaryStrategyDropdown();
        });
    });

    container.querySelectorAll('.timeframe-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            const index = parseInt(target.getAttribute('data-index')!);
            state.selectedStrategies[index].timeframe = target.value || undefined;
            updateValidation();
        });
    });

    container.querySelectorAll('.role-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const target = e.target as HTMLSelectElement;
            const index = parseInt(target.getAttribute('data-index')!);
            state.selectedStrategies[index].role = target.value as StrategyMetadata['role'];
            updateValidation();
        });
    });

    container.querySelectorAll('.combiner-remove-slot').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.getAttribute('data-index')!);
            state.selectedStrategies.splice(index, 1);
            renderStrategySlots();
            updateValidation();
            updatePrimaryStrategyDropdown();
        });
    });

    updatePrimaryStrategyDropdown();
}

function addStrategySlot(): void {
    const strategies = getStrategyList();
    if (strategies.length === 0) return;

    state.selectedStrategies.push(createStrategyMetadata(strategies[0].key, 'entry', 'both'));
    renderStrategySlots();
    updateValidation();
}

function updatePrimaryStrategyDropdown(): void {
    const primarySelect = getEl<HTMLSelectElement>('combinerPrimaryStrategy');
    const closeSelect = getEl<HTMLSelectElement>('combinerCloseStrategy');
    const shortSelect = getEl<HTMLSelectElement>('combinerShortStrategy');

    const options = state.selectedStrategies.map((s, index) => {
        const strategy = strategyRegistry.get(s.strategyId);
        const tf = s.timeframe ? ` [${s.timeframe}]` : '';
        const name = s.configName ? `${s.configName} (${strategy?.name || s.strategyId})${tf}` : `${strategy?.name || s.strategyId}${tf}`;
        return `<option value="${index}">${name}</option>`;
    }).join('');

    if (primarySelect) primarySelect.innerHTML = options;
    if (closeSelect) closeSelect.innerHTML = options;
    if (shortSelect) shortSelect.innerHTML = options;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

function updateValidation(): void {
    const container = getEl('combinerValidation');
    if (!container) return;

    const definition = buildDefinitionFromUI();
    if (!definition) {
        container.innerHTML = '';
        return;
    }

    const result = validateDefinition(definition);

    const items: string[] = [];

    if (result.errors.length > 0) {
        items.push(...result.errors.map(e => `
            <div class="combiner-validation-item error">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                ${escapeHtml(e)}
            </div>
        `));
    }

    if (result.warnings.length > 0) {
        items.push(...result.warnings.map(w => `
            <div class="combiner-validation-item warning">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                </svg>
                ${escapeHtml(w)}
            </div>
        `));
    }

    if (result.valid && result.warnings.length === 0) {
        items.push(`
            <div class="combiner-validation-item success">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                </svg>
                Valid combination ready to save
            </div>
        `);
    }

    container.innerHTML = items.join('');
}

function buildDefinitionFromUI(): CombinedStrategyDefinition | null {
    const nameInput = getEl<HTMLInputElement>('combinerName');
    const descInput = getEl<HTMLInputElement>('combinerDescription');
    const operatorSelect = getEl<HTMLSelectElement>('combinerOpenOperator');
    const conflictSelect = getEl<HTMLSelectElement>('combinerConflictResolution');
    const primarySelect = getEl<HTMLSelectElement>('combinerPrimaryStrategy');
    const closeToggle = getEl<HTMLInputElement>('combinerCloseToggle');
    const closeSelect = getEl<HTMLSelectElement>('combinerCloseStrategy');
    const shortToggle = getEl<HTMLInputElement>('combinerShortToggle');
    const shortLogicSelect = getEl<HTMLSelectElement>('combinerShortLogic');
    const shortStrategySelect = getEl<HTMLSelectElement>('combinerShortStrategy');

    if (!nameInput || state.selectedStrategies.length < 2) return null;

    const operator = (operatorSelect?.value || 'AND') as LogicOperator;
    const operands = state.selectedStrategies.map(s => createStrategyNode(s));

    // Handle close condition
    let closeCondition: any = undefined;
    if (closeToggle?.checked && closeSelect?.value) {
        const idx = parseInt(closeSelect.value);
        const strategyMeta = state.selectedStrategies[idx];
        if (strategyMeta) {
            closeCondition = createOperatorNode('AND', [createStrategyNode(strategyMeta)]);
        }
    }

    // Handle short logic
    const shortEnabled = shortToggle?.checked || false;
    let shortLogic: any = undefined;
    if (shortEnabled && shortLogicSelect?.value === 'independent' && shortStrategySelect?.value) {
        const idx = parseInt(shortStrategySelect.value);
        const strategyMeta = state.selectedStrategies[idx];
        if (strategyMeta) {
            shortLogic = createOperatorNode('AND', [createStrategyNode(strategyMeta)]);
        }
    }

    const definition: CombinedStrategyDefinition = {
        id: state.currentDefinition?.id || createEmptyDefinition(nameInput.value).id,
        name: nameInput.value || 'Unnamed Combination',
        description: descInput?.value || undefined,
        inputStrategies: state.selectedStrategies,
        executionRules: {
            openCondition: createOperatorNode(operator, operands),
            closeCondition,
            conflictResolution: (conflictSelect?.value || 'all_agree') as ConflictResolution,
            primaryStrategyId: conflictSelect?.value === 'follow_primary' && primarySelect?.value ?
                state.selectedStrategies[parseInt(primarySelect.value)]?.id : undefined,
        },
        shortHandling: {
            enabled: shortEnabled,
            shortLogic,
        },
        combinationDepth: 0,
        createdAt: state.currentDefinition?.createdAt || Date.now(),
    };

    return definition;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOGGLE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function toggleShortSettings(enabled: boolean): void {
    const settings = getEl('combinerShortSettings');
    if (settings) settings.classList.toggle('is-hidden', !enabled);
}

function toggleCloseSettings(enabled: boolean): void {
    const settings = getEl('combinerCloseSettings');
    if (settings) settings.classList.toggle('is-hidden', !enabled);
}

function togglePrimaryStrategy(resolution: string): void {
    const group = getEl('primaryStrategyGroup');
    if (group) group.classList.toggle('is-hidden', resolution !== 'follow_primary');
}

function toggleShortStrategyGroup(enabled: boolean): void {
    const group = getEl('shortStrategyGroup');
    if (group) group.classList.toggle('is-hidden', !enabled);
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

function editCombination(id: string): void {
    const definition = loadCombinedStrategy(id);
    if (definition) {
        showBuilder(definition);
    }
}

function runCombination(id: string): void {
    const definition = loadCombinedStrategy(id);
    if (!definition) return;

    // Convert to executable strategy and run backtest
    const strategy = toExecutableStrategy(definition);

    // Register temporarily and trigger backtest
    strategyRegistry.register(`combined_${id}`, strategy);

    // Dispatch event to trigger backtest
    window.dispatchEvent(new CustomEvent('run-combined-strategy', {
        detail: { strategyKey: `combined_${id}`, definition }
    }));

    uiManager.showToast(`Running: ${definition.name}`, 'info');
}

function exportCombination(id: string): void {
    const definition = loadCombinedStrategy(id);
    if (definition) {
        exportToFile(definition);
        uiManager.showToast('Exported to file', 'success');
    }
}

function deleteCombination(id: string): void {
    const definition = loadCombinedStrategy(id);
    if (!definition) return;

    if (confirm(`Delete "${definition.name}"?`)) {
        deleteCombinedStrategy(id);
        renderCombinedList();
        uiManager.showToast('Deleted', 'success');
    }
}

function saveCombination(): void {
    const definition = buildDefinitionFromUI();
    if (!definition) {
        uiManager.showToast('Please add at least 2 strategies', 'error');
        return;
    }

    const result = saveCombinedStrategy(definition);

    if (result.saved) {
        uiManager.showToast(`Saved: ${definition.name}`, 'success');
        hideBuilder();
        renderCombinedList();
    } else {
        uiManager.showToast(`Error: ${result.errors.join(', ')}`, 'error');
    }
}

function previewCombination(): void {
    const definition = buildDefinitionFromUI();
    if (!definition) {
        uiManager.showToast('Please add at least 2 strategies', 'error');
        return;
    }

    // Convert to executable and run preview
    const strategy = toExecutableStrategy(definition);
    const tempId = `preview_${Date.now()}`;
    strategyRegistry.register(tempId, strategy);

    window.dispatchEvent(new CustomEvent('run-combined-strategy', {
        detail: { strategyKey: tempId, definition, isPreview: true }
    }));

    uiManager.showToast('Preview running...', 'info');
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

export function initCombinerUI(): void {
    // New button
    const newBtn = getEl('newCombinerBtn');
    if (newBtn) {
        newBtn.addEventListener('click', () => showBuilder());
    }

    // Close builder
    const closeBtn = getEl('closeCombinerBuilder');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideBuilder);
    }

    // Cancel button
    const cancelBtn = getEl('combinerCancel');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', hideBuilder);
    }

    // Add strategy slot
    const addSlotBtn = getEl('addStrategySlot');
    if (addSlotBtn) {
        addSlotBtn.addEventListener('click', addStrategySlot);
    }

    // Save button
    const saveBtn = getEl('combinerSave');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveCombination);
    }

    // Preview button
    const previewBtn = getEl('combinerPreview');
    if (previewBtn) {
        previewBtn.addEventListener('click', previewCombination);
    }

    // Conflict resolution change
    const conflictSelect = getEl<HTMLSelectElement>('combinerConflictResolution');
    if (conflictSelect) {
        conflictSelect.addEventListener('change', () => {
            togglePrimaryStrategy(conflictSelect.value);
            updateValidation();
        });
    }

    // Short toggle
    const shortToggle = getEl<HTMLInputElement>('combinerShortToggle');
    if (shortToggle) {
        shortToggle.addEventListener('change', () => {
            toggleShortSettings(shortToggle.checked);
            updateValidation();
        });
    }

    // Close toggle
    const closeToggle = getEl<HTMLInputElement>('combinerCloseToggle');
    if (closeToggle) {
        closeToggle.addEventListener('change', () => {
            toggleCloseSettings(closeToggle.checked);
            updateValidation();
        });
    }

    // Short logic change
    const shortLogicSelect = getEl<HTMLSelectElement>('combinerShortLogic');
    if (shortLogicSelect) {
        shortLogicSelect.addEventListener('change', () => {
            toggleShortStrategyGroup(shortLogicSelect.value === 'independent');
            updateValidation();
        });
    }

    // Name input
    const nameInput = getEl<HTMLInputElement>('combinerName');
    if (nameInput) {
        nameInput.addEventListener('input', updateValidation);
    }

    // Operator change
    const operatorSelect = getEl<HTMLSelectElement>('combinerOpenOperator');
    if (operatorSelect) {
        operatorSelect.addEventListener('change', updateValidation);
    }

    // Secondary strategy selects
    ['combinerPrimaryStrategy', 'combinerCloseStrategy', 'combinerShortStrategy'].forEach(id => {
        const el = getEl(id);
        if (el) el.addEventListener('change', updateValidation);
    });

    // Render saved list
    renderCombinedList();
}

export const combinerManager = {
    init: initCombinerUI,
    renderList: renderCombinedList,
    showBuilder,
    hideBuilder,
};
