import { strategyRegistry } from "../strategyRegistry";
import { type OHLCVData, type Signal, type Time, type TradeFilterMode, type TradeDirection, type StrategyParams } from './types/strategies';

export const MAX_CONFIRMATION_STRATEGIES = 5;

const LIST_ID = "confirmationStrategyList";
const ADD_BTN_ID = "confirmationAddBtn";

interface StrategyOption {
    key: string;
    name: string;
    role?: string;
}

let confirmationParamsByKey: Record<string, StrategyParams> = {};

function timeKey(time: Time): string {
    if (typeof time === "number") return time.toString();
    if (typeof time === "string") return time;
    if (time && typeof time === "object" && "year" in time) {
        const businessDay = time as { year: number; month: number; day: number };
        const month = String(businessDay.month).padStart(2, "0");
        const day = String(businessDay.day).padStart(2, "0");
        return `${businessDay.year}-${month}-${day}`;
    }
    return String(time);
}

function getTimeIndex(data: OHLCVData[]): Map<string, number> {
    const map = new Map<string, number>();
    data.forEach((candle, index) => {
        map.set(timeKey(candle.time), index);
    });
    return map;
}

function getStrategyOptions(): StrategyOption[] {
    const options = strategyRegistry.keys().map(key => {
        const strategy = strategyRegistry.get(key);
        return {
            key,
            name: strategy?.name ?? key,
            role: strategy?.metadata?.role
        };
    });
    return options.sort((a, b) => a.name.localeCompare(b.name));
}

function buildOptionsHtml(selectedKey?: string): string {
    const options = getStrategyOptions();
    return options.map(option => {
        const selected = option.key === selectedKey ? "selected" : "";
        return `<option value="${option.key}" ${selected}>${option.name}</option>`;
    }).join("");
}

function updateActionStates(count: number, hasStrategies: boolean): void {
    const addBtn = document.getElementById(ADD_BTN_ID) as HTMLButtonElement | null;

    if (addBtn) {
        addBtn.disabled = !hasStrategies || count >= MAX_CONFIRMATION_STRATEGIES;
        addBtn.title = count >= MAX_CONFIRMATION_STRATEGIES
            ? `Limit reached (${MAX_CONFIRMATION_STRATEGIES})`
            : "Add confirmation strategy";
    }
}

function dispatchSettingsChange(): void {
    const settingsTab = document.getElementById("settingsTab");
    if (settingsTab) {
        settingsTab.dispatchEvent(new Event("change", { bubbles: true }));
    }
}

function pickDefaultStrategyKey(exclude: Set<string> = new Set()): string | null {
    const options = getStrategyOptions();
    if (options.length === 0) return null;

    const filterOptions = options.filter(option => option.role === "filter");
    const pool = filterOptions.length > 0 ? filterOptions : options;
    const available = pool.filter(option => !exclude.has(option.key));
    const targetPool = available.length > 0 ? available : pool;
    return targetPool[0]?.key ?? null;
}

function formatParamValue(value: number): string {
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatParamSummary(strategyKey: string, params?: StrategyParams): string | null {
    if (!params) return null;
    const entries = Object.entries(params);
    if (entries.length === 0) return null;
    const strategy = strategyRegistry.get(strategyKey);
    const labels = strategy?.paramLabels ?? {};
    return entries
        .map(([key, value]) => `${labels[key] ?? key}: ${formatParamValue(value)}`)
        .join(", ");
}

export function setConfirmationStrategyParams(params?: Record<string, StrategyParams>): void {
    confirmationParamsByKey = params ? { ...params } : {};
}

export function getConfirmationStrategyParams(): Record<string, StrategyParams> {
    return { ...confirmationParamsByKey };
}

export function getConfirmationStrategyValues(): string[] {
    if (typeof document === "undefined") return [];
    const list = document.getElementById(LIST_ID);
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLSelectElement>("select.confirmation-strategy-select"))
        .map(select => select.value)
        .filter(Boolean)
        .slice(0, MAX_CONFIRMATION_STRATEGIES);
}

export function renderConfirmationStrategyList(values: string[]): void {
    if (typeof document === "undefined") return;
    const list = document.getElementById(LIST_ID);
    if (!list) return;

    const options = getStrategyOptions();
    const validKeys = new Set(options.map(option => option.key));
    const sanitized = values.filter(value => validKeys.has(value)).slice(0, MAX_CONFIRMATION_STRATEGIES);
    const nextParams: Record<string, StrategyParams> = {};
    sanitized.forEach(key => {
        if (confirmationParamsByKey[key]) {
            nextParams[key] = confirmationParamsByKey[key];
        }
    });
    confirmationParamsByKey = nextParams;

    if (options.length === 0) {
        list.innerHTML = `<div class="param-hint">No strategies available.</div>`;
        updateActionStates(0, false);
        return;
    }

    if (sanitized.length === 0) {
        list.innerHTML = "";
        updateActionStates(0, true);
        return;
    }

    list.innerHTML = sanitized.map((value, index) => {
        const summary = formatParamSummary(value, confirmationParamsByKey[value]);
        const role = strategyRegistry.get(value)?.metadata?.role;
        const roleLabel = role ? `${role[0].toUpperCase()}${role.slice(1)}` : "Strategy";
        const roleClass = role ? `role-badge ${role}` : "role-badge";
        return `
        <div class="confirmation-strategy-slot" data-index="${index}">
            <select class="param-input confirmation-strategy-select" data-index="${index}">
                ${buildOptionsHtml(value)}
            </select>
            <span class="${roleClass}">${roleLabel}</span>
            <button class="confirmation-remove-btn" type="button" data-index="${index}" title="Remove">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
            </button>
            ${summary ? `<div class="confirmation-strategy-params">${summary}</div>` : ""}
        </div>
    `;
    }).join("");

    updateActionStates(sanitized.length, true);
}

export function initConfirmationStrategyUI(): void {
    if (typeof document === "undefined") return;
    const list = document.getElementById(LIST_ID);
    const addBtn = document.getElementById(ADD_BTN_ID);

    if (addBtn) {
        addBtn.addEventListener("click", () => {
            const values = getConfirmationStrategyValues();
            if (values.length >= MAX_CONFIRMATION_STRATEGIES) return;
            const exclude = new Set(values);
            const nextKey = pickDefaultStrategyKey(exclude) ?? pickDefaultStrategyKey() ?? "";
            if (!nextKey) return;
            values.push(nextKey);
            renderConfirmationStrategyList(values);
            dispatchSettingsChange();
        });
    }

    if (list) {
        list.addEventListener("click", (event) => {
            const target = event.target as HTMLElement | null;
            const button = target?.closest<HTMLButtonElement>(".confirmation-remove-btn");
            if (!button) return;
            const index = Number(button.dataset.index);
            const values = getConfirmationStrategyValues();
            if (Number.isNaN(index)) return;
            values.splice(index, 1);
            renderConfirmationStrategyList(values);
            dispatchSettingsChange();
        });

        list.addEventListener("change", (event) => {
            const target = event.target as HTMLElement | null;
            if (!target?.closest(".confirmation-strategy-select")) return;
            renderConfirmationStrategyList(getConfirmationStrategyValues());
            dispatchSettingsChange();
        });
    }

    renderConfirmationStrategyList(getConfirmationStrategyValues());

    strategyRegistry.subscribe(() => {
        renderConfirmationStrategyList(getConfirmationStrategyValues());
    });
}

export function buildConfirmationStates(
    data: OHLCVData[],
    strategyKeys: string[],
    paramsByKey?: Record<string, StrategyParams>
): Int8Array[] {
    if (data.length === 0 || strategyKeys.length === 0) return [];

    const timeIndex = getTimeIndex(data);
    const states: Int8Array[] = [];

    strategyKeys.forEach(key => {
        const strategy = strategyRegistry.get(key);
        if (!strategy) return;
        let signals: Signal[] = [];
        try {
            const params = paramsByKey?.[key] ?? strategy.defaultParams;
            signals = strategy.execute(data, params);
        } catch (error) {
            console.warn(`[ConfirmationStrategies] Failed to execute ${key}:`, error);
            return;
        }
        if (signals.length === 0) {
            states.push(new Int8Array(data.length));
            return;
        }

        const entries: Array<{ index: number; direction: number; order: number }> = [];
        signals.forEach((signal, order) => {
            const index = timeIndex.get(timeKey(signal.time));
            if (index === undefined) return;
            const direction = signal.type === "buy" ? 1 : -1;
            entries.push({ index, direction, order });
        });

        if (entries.length === 0) {
            states.push(new Int8Array(data.length));
            return;
        }

        entries.sort((a, b) => a.index - b.index || a.order - b.order);

        const state = new Int8Array(data.length);
        let current = 0;
        let cursor = 0;
        for (let i = 0; i < data.length; i++) {
            while (cursor < entries.length && entries[cursor].index === i) {
                current = entries[cursor].direction;
                cursor += 1;
            }
            state[i] = current;
        }
        states.push(state);
    });

    return states;
}

export function filterSignalsWithConfirmations(
    data: OHLCVData[],
    signals: Signal[],
    confirmationStates: Int8Array[],
    tradeFilterMode: TradeFilterMode,
    tradeDirection: TradeDirection
): Signal[] {
    if (tradeDirection === "both") {
        return filterSignalsWithConfirmationsBoth(data, signals, confirmationStates, tradeFilterMode);
    }
    if (confirmationStates.length === 0 || signals.length === 0) return signals;

    const timeIndex = getTimeIndex(data);
    const entryType: Signal["type"] = tradeDirection === "short" ? "sell" : "buy";
    const requiredState = tradeDirection === "short" ? -1 : 1;
    const useCloseConfirm = tradeFilterMode === "close";

    const filtered: Signal[] = [];

    for (const signal of signals) {
        if (signal.type !== entryType) {
            filtered.push(signal);
            continue;
        }

        const signalIndex = timeIndex.get(timeKey(signal.time));
        if (signalIndex === undefined) {
            filtered.push(signal);
            continue;
        }

        const entryIndex = useCloseConfirm ? signalIndex + 1 : signalIndex;
        if (entryIndex >= data.length) {
            continue;
        }

        let confirmed = true;
        for (const state of confirmationStates) {
            if (state[entryIndex] !== requiredState) {
                confirmed = false;
                break;
            }
        }

        if (confirmed) {
            filtered.push(signal);
        }
    }

    return filtered;
}

export function filterSignalsWithConfirmationsBoth(
    data: OHLCVData[],
    signals: Signal[],
    confirmationStates: Int8Array[],
    tradeFilterMode: TradeFilterMode
): Signal[] {
    if (confirmationStates.length === 0 || signals.length === 0) return signals;

    const timeIndex = getTimeIndex(data);
    const useCloseConfirm = tradeFilterMode === "close";

    const filtered: Signal[] = [];

    for (const signal of signals) {
        const signalIndex = timeIndex.get(timeKey(signal.time));
        if (signalIndex === undefined) {
            filtered.push(signal);
            continue;
        }

        const entryIndex = useCloseConfirm ? signalIndex + 1 : signalIndex;
        if (entryIndex >= data.length) {
            continue;
        }

        const requiredState = signal.type === "buy" ? 1 : -1;
        let confirmed = true;
        for (const state of confirmationStates) {
            if (state[entryIndex] !== requiredState) {
                confirmed = false;
                break;
            }
        }

        if (confirmed) {
            filtered.push(signal);
        }
    }

    return filtered;
}


