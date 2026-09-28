/**
 * Finder strategy selection: the toggle maps, selection sets per scope,
 * search filter, bulk/visible/range selection, and the summary UI sync.
 * Browser-only.
 *
 * Selected keys live in the persisted UI state (two independent lists, one
 * per selection scope); this class owns how those keys are toggled and how
 * the checkbox DOM stays in step. Scope resolution, persistence, and the
 * editable settings object are injected by the manager.
 */
import { strategyRegistry, getStrategyList, getStrategyKind, getStrategyKindTitle } from "../../../strategyRegistry";
import type { FinderManagerDom } from "../finder-manager-dom";
import type { FinderPersistedUiState } from "./finder-settings";

export interface FinderStrategySelectionDeps {
	getDom: () => FinderManagerDom;
	getUiState: () => FinderPersistedUiState;
	/** True when the active scope selects from the universe list. */
	isUniverseSelectionScope: () => boolean;
	/** Persist the (mutated) UI state to storage. */
	persist: () => void;
}

export class FinderStrategySelection {
	strategyToggles: Map<string, HTMLInputElement> = new Map();
	strategyItems: Map<string, HTMLDivElement> = new Map();
	strategyOrder: string[] = [];
	lastStrategyToggleKey: string | null = null;

	constructor(private readonly deps: FinderStrategySelectionDeps) {}

	private getDom(): FinderManagerDom {
		return this.deps.getDom();
	}

	private get uiState(): FinderPersistedUiState {
		return this.deps.getUiState();
	}

	private usesUniverseStrategySelection(): boolean {
		return this.deps.isUniverseSelectionScope();
	}

	private saveUiState(): void {
		this.deps.persist();
	}

	getCurrentChartSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.currentChartSelectedStrategyKeys);
	}

	getUniverseSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.universeSelectedStrategyKeys);
	}

	syncStrategyToggleInputsFromState(): void {
		this.strategyToggles.forEach((toggle, key) => {
			toggle.checked = this.isStrategySelected(key);
		});
	}

	isStrategySelected(key: string): boolean {
		return this.usesUniverseStrategySelection()
			? this.getUniverseSelectedStrategyKeys().has(key)
			: this.getCurrentChartSelectedStrategyKeys().has(key);
	}

	renderStrategySelection(): void {
		const container = this.getDom().finderStrategyList;
		container.innerHTML = '';
		this.strategyToggles.clear();
		this.strategyItems.clear();
		this.strategyOrder = [];
		this.lastStrategyToggleKey = null;

		const strategies = strategyRegistry.getAll();
		const allStrategies = getStrategyList();
		const fragment = document.createDocumentFragment();

		for (const { key, name } of allStrategies) {
			const strategy = strategies[key];
			const displayName = strategy?.name ?? name;
			const kind = getStrategyKind(key, strategy);
			const item = document.createElement('div');
			item.className = 'strategy-list-item';
			item.dataset.strategyKey = key;
			item.dataset.strategyName = displayName.toLowerCase();
			item.dataset.strategyKind = kind;
			item.title = getStrategyKindTitle(kind);

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = `finder-strategy-${key}`;
			checkbox.checked = this.isStrategySelected(key);
			checkbox.dataset.strategyKey = key;

			const label = document.createElement('label');
			label.htmlFor = `finder-strategy-${key}`;
			label.textContent = displayName;

			item.appendChild(checkbox);
			item.appendChild(label);
			fragment.appendChild(item);

			this.strategyToggles.set(key, checkbox);
			this.strategyItems.set(key, item);
			this.strategyOrder.push(key);
		}
		container.appendChild(fragment);

		this.applyStrategyFilter();
		this.syncStrategySelectionUi();
	}

	handleStrategyToggleClick(strategyKey: string, event: MouseEvent): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) return;

		if (event.shiftKey && this.lastStrategyToggleKey) {
			const orderedKeys = this.getStrategyKeysForRangeSelection();
			const startIndex = orderedKeys.indexOf(this.lastStrategyToggleKey);
			const endIndex = orderedKeys.indexOf(strategyKey);

			if (startIndex !== -1 && endIndex !== -1) {
				const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
				this.setStrategySelection(orderedKeys.slice(from, to + 1), checkbox.checked, false);
			}
		}

		this.lastStrategyToggleKey = strategyKey;
		this.syncStrategySelectionUi();
	}

	handleStrategyToggleChange(strategyKey: string): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) {
			return;
		}

		const selected = this.usesUniverseStrategySelection()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		if (checkbox.checked) {
			selected.add(strategyKey);
		} else {
			selected.delete(strategyKey);
		}
		if (this.usesUniverseStrategySelection()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();
		this.syncStrategySelectionUi();
	}

	getStrategyKeysForRangeSelection(): string[] {
		const visibleKeys = this.getVisibleStrategyKeys();
		return visibleKeys.length > 0 ? visibleKeys : this.strategyOrder;
	}

	getVisibleStrategyKeys(): string[] {
		return this.strategyOrder.filter((key) => {
			const item = this.strategyItems.get(key);
			return item ? !item.hidden : false;
		});
	}

	setStrategySelection(strategyKeys: Iterable<string>, checked: boolean, syncUi = true): void {
		const selected = this.usesUniverseStrategySelection()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = checked;
				if (checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.usesUniverseStrategySelection()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		if (syncUi) {
			this.syncStrategySelectionUi();
		}
	}

	replaceStrategySelection(strategyKeys: readonly string[]): void {
		const availableKeys = strategyKeys.filter((key) => this.strategyToggles.has(key));
		this.setStrategySelection(this.strategyOrder, false, false);
		this.setStrategySelection(availableKeys, true);
	}

	invertStrategySelection(strategyKeys: Iterable<string>): void {
		const selected = this.usesUniverseStrategySelection()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = !toggle.checked;
				if (toggle.checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.usesUniverseStrategySelection()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		this.syncStrategySelectionUi();
	}

	applyStrategyFilter(): void {
		const { finderStrategySearch: searchInput } = this.getDom();
		const query = searchInput.value.trim().toLowerCase();

		this.strategyItems.forEach((item) => {
			const strategyName = item.dataset.strategyName ?? '';
			item.hidden = query.length > 0 && !strategyName.includes(query);
		});

		this.syncStrategySelectionUi();
	}

	syncStrategySelectionUi(): void {
		const dom = this.getDom();
		const totalCount = this.strategyOrder.length;
		const visibleKeys = this.getVisibleStrategyKeys();
		const visibleSet = new Set(visibleKeys);
		let selectedCount = 0;
		let visibleSelectedCount = 0;

		this.strategyToggles.forEach((toggle, key) => {
			if (!toggle.checked) return;
			selectedCount += 1;
			if (visibleSet.has(key)) {
				visibleSelectedCount += 1;
			}
		});

		const hasFilter = dom.finderStrategySearch.value.trim().length > 0;
		dom.finderStrategiesToggleAll.checked = totalCount > 0 && selectedCount === totalCount;
		dom.finderStrategiesToggleAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
		dom.finderStrategySelectVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategyInvertVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategySummary.textContent = hasFilter
			? `${selectedCount} selected | ${visibleKeys.length} visible | ${visibleSelectedCount} visible selected`
			: `${selectedCount} selected`;
	}
}
