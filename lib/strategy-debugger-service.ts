import { builtInStrategySummary, type BuiltInStrategySummary } from "./strategies/manifest-summary";
import { backtestService } from "./backtest-service";
import { copyToClipboard } from "./browser-transfer";
import { createStrategyDebuggerDom, type StrategyDebuggerDom } from "./strategy-debugger-dom";
import { buildStrategyDebuggerDiagnostic } from "./strategy-debugger-analysis";
import {
    loadBuiltInStrategyByKey,
    strategyRegistry,
    type StrategyRegistryEvent,
} from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { state } from "./state";
import { uiManager } from "./ui-manager";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "./types/strategies";
import type { CapitalSettings } from "./types/backtest";
import type {
    StrategyDebuggerCandidateReport,
    StrategyDebuggerDiagnostic,
    StrategyDebuggerParamSource,
    StrategyDebuggerRunInput,
    StrategyDebuggerRunMeta,
} from "./strategy-debugger-types";
import {
    renderStrategyDebuggerDiagnostic,
    renderStrategyDebuggerResults,
} from "./strategy-debugger-renderer";

const DEFAULT_BASELINE_KEY = "polymarket_event_direction_follow";

interface StrategyDebuggerStrategyOption {
    key: string;
    name: string;
    description: string;
    polymarket1sConfig: boolean;
    crossSymbolConfig: boolean;
}

function cloneParams(params: StrategyParams): StrategyParams {
    return { ...params };
}

function normalizeParams(strategy: Strategy, params: StrategyParams): StrategyParams {
    return strategy.normalizeParams ? strategy.normalizeParams(params) : params;
}

function getStrategyKind(option: StrategyDebuggerStrategyOption): string {
    if (option.polymarket1sConfig) return "polymarket-1s";
    if (option.crossSymbolConfig) return "cross-symbol";
    return "standard";
}

function toOption(summary: BuiltInStrategySummary): StrategyDebuggerStrategyOption {
    return {
        key: summary.key,
        name: summary.name,
        description: summary.description,
        polymarket1sConfig: summary.polymarket1sConfig === true,
        crossSymbolConfig: summary.crossSymbolConfig === true,
    };
}

class StrategyDebuggerService {
    private dom: StrategyDebuggerDom | null = null;
    private selectedKeys = new Set<string>();
    private visibleKeys: string[] = [];
    private latestReports: StrategyDebuggerCandidateReport[] = [];
    private selectedDiagnosticKey: string | null = null;
    private latestDiagnostic: StrategyDebuggerDiagnostic | null = null;
    private initialized = false;
    private running = false;
    private cancelRequested = false;
    private registryUnsubscribe: (() => void) | null = null;
    private eventAbortController: AbortController | null = null;

    public init(): void {
        if (this.initialized) return;
        this.dom = createStrategyDebuggerDom();
        this.bindEvents();
        this.registryUnsubscribe = strategyRegistry.subscribe((event: StrategyRegistryEvent) => {
            if (event.type === "register" || event.type === "unregister" || event.type === "update" || event.type === "clear") {
                this.renderStrategyControls();
            }
        });
        this.renderStrategyControls();
        this.renderResults();
        this.initialized = true;
    }

    public destroy(): void {
        this.eventAbortController?.abort();
        this.eventAbortController = null;
        this.registryUnsubscribe?.();
        this.registryUnsubscribe = null;
        this.initialized = false;
        this.dom = null;
    }

    private getDom(): StrategyDebuggerDom {
        if (!this.dom) {
            this.dom = createStrategyDebuggerDom();
        }
        return this.dom;
    }

    private bindEvents(): void {
        const dom = this.getDom();
        this.eventAbortController?.abort();
        this.eventAbortController = new AbortController();
        const listenerOptions = { signal: this.eventAbortController.signal };

        dom.search.addEventListener("input", () => this.renderStrategyControls(), listenerOptions);
        dom.onlyPolymarket1s.addEventListener("change", () => this.renderStrategyControls(), listenerOptions);
        dom.selectVisible.addEventListener("click", () => {
            for (const key of this.visibleKeys) {
                if (key !== dom.baseline.value) {
                    this.selectedKeys.add(key);
                }
            }
            this.renderStrategyControls();
        }, listenerOptions);
        dom.selectNone.addEventListener("click", () => {
            this.selectedKeys.clear();
            this.renderStrategyControls();
        }, listenerOptions);
        dom.baseline.addEventListener("change", () => this.renderStrategyControls(), listenerOptions);
        dom.run.addEventListener("click", () => {
            void this.runDebugger();
        }, listenerOptions);
        dom.stop.addEventListener("click", () => {
            this.cancelRequested = true;
            this.setStatus("Stopping after current candidate...");
        }, listenerOptions);
        dom.copyDiagnostic.addEventListener("click", () => {
            void this.copyCurrentDiagnostic();
        }, listenerOptions);
    }

    private getStrategyOptions(): StrategyDebuggerStrategyOption[] {
        const byKey = new Map<string, StrategyDebuggerStrategyOption>();
        for (const summary of builtInStrategySummary) {
            byKey.set(summary.key, toOption(summary));
        }
        for (const key of strategyRegistry.keys()) {
            if (byKey.has(key)) continue;
            const strategy = strategyRegistry.get(key);
            if (!strategy) continue;
            byKey.set(key, {
                key,
                name: strategy.name,
                description: strategy.description,
                polymarket1sConfig: Boolean(strategy.polymarket1sConfig),
                crossSymbolConfig: Boolean(strategy.crossSymbolConfig),
            });
        }
        return [...byKey.values()].sort((left, right) => {
            if (left.polymarket1sConfig !== right.polymarket1sConfig) {
                return left.polymarket1sConfig ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
        });
    }

    private getFilteredOptions(): StrategyDebuggerStrategyOption[] {
        const dom = this.getDom();
        const query = dom.search.value.trim().toLowerCase();
        const baselineKey = dom.baseline.value;
        return this.getStrategyOptions().filter((option) => {
            if (option.key === baselineKey) return false;
            if (dom.onlyPolymarket1s.checked && !option.polymarket1sConfig) return false;
            if (!query) return true;
            return option.key.toLowerCase().includes(query)
                || option.name.toLowerCase().includes(query)
                || option.description.toLowerCase().includes(query);
        });
    }

    private renderBaselineOptions(options: readonly StrategyDebuggerStrategyOption[]): void {
        const dom = this.getDom();
        const previous = dom.baseline.value || DEFAULT_BASELINE_KEY;
        const fragment = document.createDocumentFragment();
        for (const option of options) {
            const selectOption = document.createElement("option");
            selectOption.value = option.key;
            selectOption.textContent = option.name;
            fragment.appendChild(selectOption);
        }
        dom.baseline.replaceChildren(fragment);
        const nextValue = options.some((option) => option.key === previous)
            ? previous
            : options.some((option) => option.key === DEFAULT_BASELINE_KEY)
                ? DEFAULT_BASELINE_KEY
                : options[0]?.key ?? "";
        dom.baseline.value = nextValue;
    }

    private renderStrategyControls(): void {
        const dom = this.getDom();
        const allOptions = this.getStrategyOptions();
        this.renderBaselineOptions(allOptions);
        const validKeys = new Set(allOptions.map((option) => option.key));
        for (const key of this.selectedKeys) {
            if (!validKeys.has(key) || key === dom.baseline.value) {
                this.selectedKeys.delete(key);
            }
        }
        const filtered = this.getFilteredOptions();
        this.visibleKeys = filtered.map((option) => option.key);

        const fragment = document.createDocumentFragment();
        for (const option of filtered) {
            const item = document.createElement("div");
            item.className = "strategy-list-item";
            item.dataset.strategyKind = getStrategyKind(option);

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.selectedKeys.has(option.key);
            checkbox.id = `strategy_debugger_candidate_${option.key}`;
            checkbox.disabled = this.running;
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    this.selectedKeys.add(option.key);
                } else {
                    this.selectedKeys.delete(option.key);
                }
                this.updateStrategySummary();
            });

            const label = document.createElement("label");
            label.htmlFor = checkbox.id;
            label.textContent = option.name;

            item.append(checkbox, label);
            fragment.appendChild(item);
        }
        dom.strategyList.replaceChildren(fragment);
        this.updateStrategySummary();
    }

    private updateStrategySummary(): void {
        const dom = this.getDom();
        const selectedVisible = this.visibleKeys.filter((key) => this.selectedKeys.has(key)).length;
        dom.strategySummary.textContent = `${this.selectedKeys.size} selected | ${selectedVisible} visible`;
    }

    private setRunning(running: boolean): void {
        const dom = this.getDom();
        this.running = running;
        dom.run.disabled = running;
        dom.stop.style.display = running ? "" : "none";
        dom.baseline.disabled = running;
        dom.minScored.disabled = running;
        dom.search.disabled = running;
        dom.onlyPolymarket1s.disabled = running;
        dom.selectVisible.disabled = running;
        dom.selectNone.disabled = running;
        dom.strategyList.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((checkbox) => {
            checkbox.disabled = running;
        });
    }

    private setProgress(done: number, total: number, label: string): void {
        const dom = this.getDom();
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        dom.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        dom.progressText.textContent = label;
    }

    private setStatus(text: string): void {
        this.getDom().status.textContent = text;
    }

    private getSelectedCandidateKeys(): string[] {
        const baselineKey = this.getDom().baseline.value;
        return [...this.selectedKeys].filter((key) => key && key !== baselineKey);
    }

    private async resolveStrategy(key: string): Promise<Strategy> {
        const strategy = strategyRegistry.get(key) ?? await loadBuiltInStrategyByKey(key);
        if (!strategy) {
            throw new Error(`Strategy not found: ${key}`);
        }
        return strategy;
    }

    private resolveParams(key: string, strategy: Strategy): { params: StrategyParams; paramSource: StrategyDebuggerParamSource } {
        if (key === state.currentStrategyKey) {
            return {
                params: normalizeParams(strategy, paramManager.getValues(strategy)),
                paramSource: "current_ui",
            };
        }
        return {
            params: normalizeParams(strategy, cloneParams(strategy.defaultParams)),
            paramSource: "strategy_default",
        };
    }

    private async runStrategy(
        key: string,
        ohlcvData: readonly OHLCVData[],
        symbol: string,
        interval: string,
        settings: BacktestSettings,
        capitalSettings: CapitalSettings
    ): Promise<StrategyDebuggerRunInput> {
        const strategy = await this.resolveStrategy(key);
        const { params, paramSource } = this.resolveParams(key, strategy);
        const run = await backtestService.evaluateStrategyOnDataWithPolymarket(
            [...ohlcvData],
            symbol,
            interval,
            key,
            strategy,
            params,
            settings,
            capitalSettings
        );
        return {
            strategyKey: key,
            strategyName: strategy.name,
            params,
            paramSource,
            result: run.result,
        };
    }

    private buildRunMeta(settings: BacktestSettings, symbol: string, interval: string): StrategyDebuggerRunMeta {
        return {
            symbol,
            interval,
            executionModel: settings.executionModel ?? "signal_close",
            polymarketExitMode: settings.polymarketExitMode ?? "resolve_hold",
            riskManagement: {
                chart: {
                    riskMode: settings.riskMode,
                    stopLossAtr: settings.stopLossAtr,
                    takeProfitAtr: settings.takeProfitAtr,
                    stopLossEnabled: settings.stopLossEnabled,
                    stopLossPercent: settings.stopLossPercent,
                    takeProfitEnabled: settings.takeProfitEnabled,
                    takeProfitPercent: settings.takeProfitPercent,
                    takeProfitMode: settings.takeProfitMode,
                    disableSignalExits: settings.disableSignalExits,
                    riskMinHoldEnabled: settings.riskMinHoldEnabled,
                    riskMinHoldBars: settings.riskMinHoldBars,
                    riskMaxHoldEnabled: settings.riskMaxHoldEnabled,
                    riskMaxHoldBars: settings.riskMaxHoldBars,
                },
                polymarketProtection: {
                    takeProfitEnabled: settings.polymarketProtectionTakeProfitEnabled,
                    takeProfitCents: settings.polymarketProtectionTakeProfitCents,
                    stopLossEnabled: settings.polymarketProtectionStopLossEnabled,
                    stopLossCents: settings.polymarketProtectionStopLossCents,
                },
            },
            generatedAtIso: new Date().toISOString(),
            singleRangeOnly: true,
        };
    }

    private async runDebugger(): Promise<void> {
        if (this.running) return;
        const dom = this.getDom();
        const candidateKeys = this.getSelectedCandidateKeys();
        if (state.ohlcvData.length === 0) {
            uiManager.showToast("Load chart data before running Strategy Debugger.", "error");
            return;
        }
        if (candidateKeys.length === 0) {
            uiManager.showToast("Select at least one candidate strategy.", "error");
            return;
        }

        this.cancelRequested = false;
        this.latestReports = [];
        this.selectedDiagnosticKey = null;
        this.latestDiagnostic = null;
        this.renderResults();
        this.setRunning(true);
        this.setProgress(0, candidateKeys.length + 1, "Preparing baseline...");
        this.setStatus("Running baseline...");

        const ohlcvData = state.ohlcvData.slice();
        const symbol = state.currentSymbol;
        const interval = state.currentInterval;
        const settings: BacktestSettings = {
            ...backtestService.getBacktestSettings(),
            polymarketAnnotationEnabled: true,
        };
        const capitalSettings = backtestService.getCapitalSettings();
        const baselineKey = dom.baseline.value || DEFAULT_BASELINE_KEY;
        const runMeta = this.buildRunMeta(settings, symbol, interval);
        const minScoredTrades = Math.max(0, Math.floor(Number(dom.minScored.value) || 0));

        try {
            const baseline = await this.runStrategy(baselineKey, ohlcvData, symbol, interval, settings, capitalSettings);
            this.setProgress(1, candidateKeys.length + 1, `Baseline ready. Running ${candidateKeys.length} candidates...`);

            for (let i = 0; i < candidateKeys.length; i++) {
                if (this.cancelRequested) break;
                const key = candidateKeys[i]!;
                this.setStatus(`Running ${key} (${i + 1}/${candidateKeys.length})...`);
                try {
                    const candidate = await this.runStrategy(key, ohlcvData, symbol, interval, settings, capitalSettings);
                    const diagnostic = buildStrategyDebuggerDiagnostic({
                        run: runMeta,
                        baseline,
                        candidate,
                        minScoredTrades,
                    });
                    this.latestReports.push({
                        candidateKey: key,
                        candidateName: candidate.strategyName,
                        diagnostic,
                        error: null,
                    });
                    if (!this.selectedDiagnosticKey) {
                        this.selectedDiagnosticKey = key;
                        this.latestDiagnostic = diagnostic;
                    }
                } catch (error) {
                    this.latestReports.push({
                        candidateKey: key,
                        candidateName: key,
                        diagnostic: null,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                this.setProgress(i + 2, candidateKeys.length + 1, `Completed ${i + 1}/${candidateKeys.length} candidates`);
                this.renderResults();
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            this.setStatus(this.cancelRequested ? "Stopped." : "Complete.");
        } catch (error) {
            this.latestReports = [{
                candidateKey: baselineKey,
                candidateName: baselineKey,
                diagnostic: null,
                error: error instanceof Error ? `Baseline failed: ${error.message}` : String(error),
            }];
            this.setStatus("Baseline failed.");
            uiManager.showToast("Strategy Debugger baseline failed. See output row.", "error");
        } finally {
            this.setRunning(false);
            this.renderResults();
        }
    }

    private selectDiagnostic(candidateKey: string): void {
        const report = this.latestReports.find((item) => item.candidateKey === candidateKey);
        this.selectedDiagnosticKey = candidateKey;
        this.latestDiagnostic = report?.diagnostic ?? null;
        this.renderResults();
    }

    private renderResults(): void {
        const dom = this.getDom();
        renderStrategyDebuggerResults(
            dom,
            this.latestReports,
            this.selectedDiagnosticKey,
            (candidateKey) => this.selectDiagnostic(candidateKey)
        );
        renderStrategyDebuggerDiagnostic(dom, this.latestDiagnostic);
    }

    private async copyCurrentDiagnostic(): Promise<void> {
        if (!this.latestDiagnostic) return;
        const copied = await copyToClipboard(JSON.stringify(this.latestDiagnostic, null, 2));
        uiManager.showToast(copied ? "Strategy Debugger diagnostic copied." : "Copy failed.", copied ? "success" : "error");
    }
}

export const strategyDebuggerService = new StrategyDebuggerService();
