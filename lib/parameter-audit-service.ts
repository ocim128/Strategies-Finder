import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { buildExecutionAwareCandleWindow, selectClosedCandleWindow } from "./alert-evaluation-window";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { dataManager } from "./data-manager";
import { debugLogger } from "./debug-logger";
import { createParameterAuditDom, type ParameterAuditDom } from "./feature-dom-contracts";
import { finderManager } from "./finder-manager";
import { buildParameterAuditReport, computeParameterAuditPerformanceScore } from "./parameter-audit-logic";
import { paramManager } from "./param-manager";
import { settingsManager } from "./settings-manager";
import { state } from "./state";
import { walkForwardService } from "./walk-forward-service";
import { deriveAutoWalkForwardRange, resolveFiniteRangeReferenceValue, shouldTreatParamAsWholeNumber } from "./walk-forward-range-utils";
import { applySignalPolarity, type BacktestSettings, type OHLCVData, type Strategy, type StrategyParams } from "./strategies";
import { runBacktestCompact } from "./strategies/backtest";
import type { ParameterRange, WalkForwardResult } from "./strategies/walk-forward";
import type { CapitalSettings } from "./types/backtest";
import type { FinderResult } from "./types/finder";
import type {
    ParameterAuditParameterInput,
    ParameterAuditReport,
    ParameterAuditSample,
    ParameterAuditSourceType,
} from "./types/parameter-audit";

type AuditBacktestContext = CapitalSettings;

type SourceContext = {
    sourceType: ParameterAuditSourceType;
    sourceLabel: string;
    strategyKey: string;
    strategy: Strategy;
    baseParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: AuditBacktestContext;
    finderResults: FinderResult[];
    wfaResult: WalkForwardResult | null;
    wfaMatch: "none" | "strategy" | "exact";
    notes: string[];
};

type PersistedAuditState = {
    sourceType: ParameterAuditSourceType;
    savedConfigName: string;
};

const STORAGE_KEY = "parameterAuditSettings";

class ParameterAuditService {
    private dom: ParameterAuditDom | null = null;
    private isRunning = false;

    private getDom(): ParameterAuditDom {
        return this.dom ??= createParameterAuditDom();
    }

    public init(): void {
        const dom = this.getDom();
        this.populateSavedConfigs();
        this.restoreUiState();
        this.updateSavedConfigVisibility();
        this.renderIdleState("Select a source and run the audit.");

        dom.parameterAuditSource.addEventListener("change", () => {
            this.updateSavedConfigVisibility();
            this.persistUiState();
            this.renderSourcePreview();
        });

        dom.parameterAuditSavedConfig.addEventListener("change", () => {
            this.persistUiState();
            this.renderSourcePreview();
        });

        dom.parameterAuditRun.addEventListener("click", () => {
            void this.runAudit();
        });

        window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
            if (event.detail?.tabId !== "paramaudit") return;
            this.populateSavedConfigs();
            this.updateSavedConfigVisibility();
            this.renderSourcePreview();
        }) as EventListener);
    }

    private restoreUiState(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<PersistedAuditState>;
            const dom = this.getDom();

            if (parsed.sourceType) {
                dom.parameterAuditSource.value = parsed.sourceType;
            }
            if (parsed.savedConfigName) {
                dom.parameterAuditSavedConfig.value = parsed.savedConfigName;
            }
        } catch (error) {
            debugLogger.warn(`[ParameterAudit] Failed to restore UI state: ${error}`);
        }
    }

    private persistUiState(): void {
        const dom = this.getDom();
        const stateToPersist: PersistedAuditState = {
            sourceType: this.readSourceType(),
            savedConfigName: dom.parameterAuditSavedConfig.value,
        };

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToPersist));
        } catch (error) {
            debugLogger.warn(`[ParameterAudit] Failed to persist UI state: ${error}`);
        }
    }

    private readSourceType(): ParameterAuditSourceType {
        const raw = this.getDom().parameterAuditSource.value as ParameterAuditSourceType;
        switch (raw) {
            case "saved_configuration":
            case "latest_finder_candidate":
            case "latest_wfa_result":
                return raw;
            case "current_strategy":
            default:
                return "current_strategy";
        }
    }

    private populateSavedConfigs(): void {
        const dom = this.getDom();
        const configs = [...settingsManager.loadAllStrategyConfigs()].sort((left, right) =>
            String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
        );
        const previous = dom.parameterAuditSavedConfig.value;

        dom.parameterAuditSavedConfig.innerHTML = '<option value="">Select saved configuration</option>';
        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = `${config.name} (${config.strategyKey})`;
            dom.parameterAuditSavedConfig.appendChild(option);
        }

        if (previous && configs.some((config) => config.name === previous)) {
            dom.parameterAuditSavedConfig.value = previous;
        }
    }

    private updateSavedConfigVisibility(): void {
        const dom = this.getDom();
        const needsConfig = this.readSourceType() === "saved_configuration";
        dom.parameterAuditSavedConfigGroup.hidden = !needsConfig;
        dom.parameterAuditSavedConfigGroup.style.display = needsConfig ? "" : "none";
    }

    private renderIdleState(message: string): void {
        const dom = this.getDom();
        dom.parameterAuditStatus.textContent = message;
        dom.parameterAuditProgress.style.display = "none";
        dom.parameterAuditProgressFill.style.width = "0%";
        dom.parameterAuditProgressText.textContent = "Ready";
        dom.parameterAuditSourceSummary.textContent = "No audit has been run yet.";
        dom.parameterAuditIncludedParams.textContent = "Included params: none";
        dom.parameterAuditEvidence.textContent = "Evidence: waiting";
        dom.parameterAuditSummary.innerHTML = `
            <div class="empty-state empty-state-compact">
                <div class="empty-state-description">${this.escapeHtml(message)}</div>
            </div>
        `;
        dom.parameterAuditEmpty.hidden = false;
        dom.parameterAuditEmpty.style.display = "";
        dom.parameterAuditTableBody.innerHTML = `
            <tr>
                <td colspan="10" class="empty-cell">No audit data</td>
            </tr>
        `;
    }

    private renderUnavailableState(message: string): void {
        this.renderIdleState(message);
    }

    private setProgress(percent: number, text: string, status = text): void {
        const dom = this.getDom();
        dom.parameterAuditProgress.style.display = "block";
        dom.parameterAuditProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.parameterAuditProgressText.textContent = text;
        dom.parameterAuditStatus.textContent = status;
    }

    private clearProgress(): void {
        const dom = this.getDom();
        dom.parameterAuditProgress.style.display = "none";
        dom.parameterAuditProgressFill.style.width = "0%";
        dom.parameterAuditProgressText.textContent = "Ready";
    }

    private async runAudit(): Promise<void> {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;
        this.persistUiState();
        const dom = this.getDom();
        dom.parameterAuditRun.disabled = true;
        dom.parameterAuditRun.setAttribute("aria-busy", "true");

        try {
            this.setProgress(5, "Resolving audit source...");
            const sourceContext = this.resolveSourceContext();
            if (!sourceContext) {
                return;
            }

            this.renderSourceHeader(sourceContext, []);

            this.setProgress(12, "Preparing current chart data...");
            const auditData = await this.ensureAuditData(sourceContext.backtestSettings);
            if (auditData.length === 0) {
                this.renderUnavailableState("No chart data is loaded for the current symbol and interval.");
                return;
            }

            const paramNames = this.getRelevantParamNames(sourceContext.strategy, sourceContext.baseParams);
            if (paramNames.length === 0) {
                this.renderUnavailableState("This strategy has no numeric walk-forward-relevant parameters to audit.");
                return;
            }

            this.renderSourceHeader(sourceContext, paramNames);

            const preparedData = sourceContext.strategy.prepareFinderData?.(auditData, sourceContext.backtestSettings);
            const inputs: ParameterAuditParameterInput[] = [];
            let usedMiniRuns = false;
            let usedWfaReuse = false;
            let usedFinderReuse = false;

            for (let index = 0; index < paramNames.length; index += 1) {
                const paramName = paramNames[index];
                const paramLabel = sourceContext.strategy.paramLabels[paramName] || paramName;
                const range = this.buildParameterRange(paramName, sourceContext.strategy.defaultParams, sourceContext.baseParams);
                if (!range) {
                    continue;
                }

                const progressBase = 15 + (index / Math.max(1, paramNames.length)) * 75;
                this.setProgress(progressBase, `Collecting evidence for ${paramLabel}...`);

                const samples: ParameterAuditSample[] = [];
                const wfaSamples = this.buildWfaSamples(sourceContext, paramName);
                if (wfaSamples.length > 0) {
                    samples.push(...wfaSamples);
                    usedWfaReuse = true;
                }

                const finderSamples = this.buildFinderSamples(sourceContext, paramName);
                if (finderSamples.length > 0) {
                    samples.push(...finderSamples);
                    usedFinderReuse = true;
                }

                if (this.shouldRunMiniSensitivity(samples)) {
                    const miniRunSamples = await this.runMiniSensitivityChecks(
                        sourceContext,
                        auditData,
                        preparedData,
                        paramName,
                        paramLabel,
                        range,
                        (index + 1) / Math.max(1, paramNames.length)
                    );
                    if (miniRunSamples.length > 0) {
                        samples.push(...miniRunSamples);
                        usedMiniRuns = true;
                    }
                }

                inputs.push({
                    name: paramName,
                    label: paramLabel,
                    baseValue: sourceContext.baseParams[paramName] ?? sourceContext.strategy.defaultParams[paramName],
                    range,
                    samples,
                });

                await this.yieldControl();
            }

            if (inputs.length === 0) {
                this.renderUnavailableState("No auditable parameters produced valid ranges.");
                return;
            }

            this.setProgress(94, "Scoring parameter usefulness...");
            const report = buildParameterAuditReport({
                strategyKey: sourceContext.strategyKey,
                strategyName: sourceContext.strategy.name,
                sourceType: sourceContext.sourceType,
                sourceLabel: sourceContext.sourceLabel,
                parameters: inputs,
                usedMiniRuns,
                usedWfaReuse,
                usedFinderReuse,
            });

            this.renderReport(report, sourceContext, {
                usedMiniRuns,
                usedWfaReuse,
                usedFinderReuse,
            });
            this.setProgress(100, "Parameter audit complete.", "Parameter audit complete.");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.error("parameter_audit.run_failed", { error: message });
            this.renderUnavailableState(`Parameter audit failed: ${message}`);
        } finally {
            this.isRunning = false;
            dom.parameterAuditRun.disabled = false;
            dom.parameterAuditRun.setAttribute("aria-busy", "false");
            this.clearProgress();
        }
    }

    private resolveSourceContext(): SourceContext | null {
        const sourceType = this.readSourceType();
        const finderResults = finderManager.getLatestResults();
        const latestFinderCandidate = finderManager.getLatestCandidate();
        const latestWfaResult = walkForwardService.getLastResult();
        const latestWfaBaseParams = walkForwardService.getLastRunBaseParams();

        switch (sourceType) {
            case "saved_configuration": {
                const configName = this.getDom().parameterAuditSavedConfig.value;
                if (!configName) {
                    this.renderUnavailableState("Pick a saved configuration before running Parameter Audit.");
                    return null;
                }

                const config = settingsManager.loadStrategyConfig(configName);
                if (!config) {
                    this.renderUnavailableState(`Saved configuration "${configName}" is no longer available.`);
                    return null;
                }

                const strategy = strategyRegistry.get(config.strategyKey);
                if (!strategy) {
                    this.renderUnavailableState(`Strategy "${config.strategyKey}" from saved config could not be loaded.`);
                    return null;
                }

                return {
                    sourceType,
                    sourceLabel: `Saved Configuration: ${config.name}`,
                    strategyKey: config.strategyKey,
                    strategy,
                    baseParams: this.normalizeStrategyParams(strategy, {
                        ...strategy.defaultParams,
                        ...config.strategyParams,
                    }),
                    backtestSettings: resolveBacktestSettingsFromRaw(config.backtestSettings as BacktestSettings, {
                        captureSnapshots: true,
                        coerceWithoutUiToggles: false,
                    }),
                    capitalSettings: settingsManager.resolveCapitalFromConfig(config),
                    finderResults: finderResults.filter((result) => result.key === config.strategyKey),
                    wfaResult: latestWfaBaseParams?.strategyKey === config.strategyKey ? latestWfaResult : null,
                    wfaMatch: this.resolveWfaMatch(config.strategyKey, config.strategyParams, latestWfaBaseParams),
                    notes: [`Current chart data: ${state.currentSymbol} ${state.currentInterval}.`],
                };
            }
            case "latest_finder_candidate": {
                if (!latestFinderCandidate) {
                    this.renderUnavailableState("Finder has no stored candidate yet. Run Finder first.");
                    return null;
                }

                const strategy = strategyRegistry.get(latestFinderCandidate.key);
                if (!strategy) {
                    this.renderUnavailableState(`Finder candidate strategy "${latestFinderCandidate.key}" could not be loaded.`);
                    return null;
                }

                const finderSettings = finderManager.getLastRunBacktestSettings() ?? backtestService.getBacktestSettings();
                const notes = [`Current chart data: ${state.currentSymbol} ${state.currentInterval}.`];
                if (latestFinderCandidate.comboMode) {
                    notes.push("Finder combo candidates are audited as standalone secondary strategy params.");
                }

                return {
                    sourceType,
                    sourceLabel: `Latest Finder Candidate: ${latestFinderCandidate.name}`,
                    strategyKey: latestFinderCandidate.key,
                    strategy,
                    baseParams: this.normalizeStrategyParams(strategy, {
                        ...strategy.defaultParams,
                        ...latestFinderCandidate.params,
                    }),
                    backtestSettings: finderSettings,
                    capitalSettings: backtestService.getCapitalSettings(),
                    finderResults: finderResults.filter((result) => result.key === latestFinderCandidate.key),
                    wfaResult: latestWfaBaseParams?.strategyKey === latestFinderCandidate.key ? latestWfaResult : null,
                    wfaMatch: this.resolveWfaMatch(latestFinderCandidate.key, latestFinderCandidate.params, latestWfaBaseParams),
                    notes,
                };
            }
            case "latest_wfa_result": {
                if (!latestWfaResult || !latestWfaBaseParams) {
                    this.renderUnavailableState("Walk Forward has no stored result yet. Run WFA first.");
                    return null;
                }

                const strategy = strategyRegistry.get(latestWfaBaseParams.strategyKey);
                if (!strategy) {
                    this.renderUnavailableState(`WFA strategy "${latestWfaBaseParams.strategyKey}" could not be loaded.`);
                    return null;
                }

                return {
                    sourceType,
                    sourceLabel: `Latest WFA Result: ${strategy.name}`,
                    strategyKey: latestWfaBaseParams.strategyKey,
                    strategy,
                    baseParams: this.normalizeStrategyParams(strategy, {
                        ...strategy.defaultParams,
                        ...latestWfaBaseParams.params,
                    }),
                    backtestSettings: backtestService.getBacktestSettings(),
                    capitalSettings: backtestService.getCapitalSettings(),
                    finderResults: finderResults.filter((result) => result.key === latestWfaBaseParams.strategyKey),
                    wfaResult: latestWfaResult,
                    wfaMatch: "exact",
                    notes: [
                        "Reuses optimized window selections from the latest recorded WFA run.",
                        `Current chart data: ${state.currentSymbol} ${state.currentInterval}.`,
                    ],
                };
            }
            case "current_strategy":
            default: {
                const strategy = strategyRegistry.get(state.currentStrategyKey);
                if (!strategy) {
                    this.renderUnavailableState(`Current strategy "${state.currentStrategyKey}" could not be loaded.`);
                    return null;
                }

                const currentParams = this.normalizeStrategyParams(strategy, paramManager.getValues(strategy));
                return {
                    sourceType: "current_strategy",
                    sourceLabel: `Current Strategy: ${strategy.name}`,
                    strategyKey: state.currentStrategyKey,
                    strategy,
                    baseParams: currentParams,
                    backtestSettings: backtestService.getBacktestSettings(),
                    capitalSettings: backtestService.getCapitalSettings(),
                    finderResults: finderResults.filter((result) => result.key === state.currentStrategyKey),
                    wfaResult: latestWfaBaseParams?.strategyKey === state.currentStrategyKey ? latestWfaResult : null,
                    wfaMatch: this.resolveWfaMatch(state.currentStrategyKey, currentParams, latestWfaBaseParams),
                    notes: [`Current chart data: ${state.currentSymbol} ${state.currentInterval}.`],
                };
            }
        }
    }

    private normalizeStrategyParams(strategy: Strategy, params: StrategyParams): StrategyParams {
        const cloned = { ...params };
        return strategy.normalizeParams ? strategy.normalizeParams(cloned) : cloned;
    }

    private resolveWfaMatch(
        strategyKey: string,
        baseParams: StrategyParams,
        wfaBaseParams: { strategyKey: string; params: StrategyParams } | null
    ): "none" | "strategy" | "exact" {
        if (!wfaBaseParams || wfaBaseParams.strategyKey !== strategyKey) {
            return "none";
        }

        const keys = new Set([...Object.keys(baseParams), ...Object.keys(wfaBaseParams.params)]);
        for (const key of keys) {
            if ((baseParams[key] ?? null) !== (wfaBaseParams.params[key] ?? null)) {
                return "strategy";
            }
        }
        return "exact";
    }

    private async ensureAuditData(settings: BacktestSettings): Promise<OHLCVData[]> {
        const contextKey = `${state.currentSymbol}|${state.currentInterval}`;
        if (state.ohlcvData.length === 0 || dataManager.getLoadedContextKey() !== contextKey) {
            await dataManager.loadData(state.currentSymbol, state.currentInterval);
        }

        return this.selectClosedCandleData(state.ohlcvData, state.currentInterval, settings);
    }

    private selectClosedCandleData(
        data: OHLCVData[],
        interval: string,
        settings: BacktestSettings
    ): OHLCVData[] {
        const closedWindow = selectClosedCandleWindow(
            data,
            interval,
            Math.floor(Date.now() / 1000),
            1
        );

        if (closedWindow) {
            const executionAware = buildExecutionAwareCandleWindow(
                closedWindow.candles,
                closedWindow.nextOpenCandle,
                settings
            );
            return sliceOhlcvByBlock(executionAware, state.blockRange);
        }

        const closed = trimToClosedCandles(data, interval);
        const executionAware = buildExecutionAwareCandleWindow(closed, null, settings);
        return sliceOhlcvByBlock(executionAware, state.blockRange);
    }

    private getRelevantParamNames(strategy: Strategy, baseParams: StrategyParams): string[] {
        const walkForwardParams = strategy.metadata?.walkForwardParams;
        if (walkForwardParams && walkForwardParams.length > 0) {
            return walkForwardParams.filter((name) =>
                Number.isFinite(baseParams[name] ?? strategy.defaultParams[name])
            );
        }

        return Object.keys({ ...strategy.defaultParams, ...baseParams }).filter((name) =>
            Number.isFinite(baseParams[name] ?? strategy.defaultParams[name])
        );
    }

    private buildParameterRange(
        name: string,
        defaults: StrategyParams,
        current: StrategyParams
    ): ParameterRange | null {
        const baseValue = resolveFiniteRangeReferenceValue(current[name], defaults[name], 10);
        if (!Number.isFinite(baseValue)) {
            return null;
        }

        if (/^use[A-Z]/.test(name) && (baseValue === 0 || baseValue === 1)) {
            return { name, min: 0, max: 1, step: 1 };
        }

        const { min, max, step } = deriveAutoWalkForwardRange(name, baseValue);
        if (!(min < max) || !Number.isFinite(step) || step <= 0) {
            return null;
        }

        if (shouldTreatParamAsWholeNumber(name, baseValue)) {
            return {
                name,
                min: Math.max(1, Math.round(min)),
                max: Math.max(Math.max(1, Math.round(min)) + 1, Math.round(max)),
                step: Math.max(1, Math.round(step)),
            };
        }

        return {
            name,
            min: Math.round(min * 1000) / 1000,
            max: Math.round(max * 1000) / 1000,
            step: Math.round(step * 1000) / 1000,
        };
    }

    private shouldRunMiniSensitivity(samples: ParameterAuditSample[]): boolean {
        const distinctValues = new Set(
            samples
                .filter((sample) => Number.isFinite(sample.value))
                .map((sample) => sample.value.toFixed(6))
        );
        const reusableSamples = samples.filter((sample) => sample.origin !== "mini_run");
        return reusableSamples.length < 4 || distinctValues.size < 2;
    }

    private buildWfaSamples(sourceContext: SourceContext, paramName: string): ParameterAuditSample[] {
        if (!sourceContext.wfaResult) return [];

        const windowScores = sourceContext.wfaResult.windows.map((window) =>
            computeParameterAuditPerformanceScore(window.outOfSampleResult)
        );
        const threshold = this.computeMedian(windowScores);

        return sourceContext.wfaResult.windows
            .map((window, index) => {
                const value = window.optimizedParams[paramName];
                if (!Number.isFinite(value)) return null;
                const score = windowScores[index] ?? computeParameterAuditPerformanceScore(window.outOfSampleResult);
                const sample: ParameterAuditSample = {
                    origin: "wfa_window" as const,
                    value,
                    score,
                    accepted: score >= threshold || window.outOfSampleResult.netProfitPercent >= 0,
                    params: { ...window.optimizedParams },
                    label: `WFA window ${window.windowIndex + 1}`,
                };
                return sample;
            })
            .filter((sample): sample is ParameterAuditSample => sample !== null);
    }

    private buildFinderSamples(sourceContext: SourceContext, paramName: string): ParameterAuditSample[] {
        if (sourceContext.finderResults.length === 0) return [];

        const scores = sourceContext.finderResults.map((result) =>
            computeParameterAuditPerformanceScore(result.selectionResult)
        );
        const threshold = this.computeMedian(scores);

        return sourceContext.finderResults
            .map((result, index) => {
                const value = result.params[paramName];
                if (!Number.isFinite(value)) return null;
                const score = scores[index] ?? computeParameterAuditPerformanceScore(result.selectionResult);
                const sample: ParameterAuditSample = {
                    origin: "finder_result" as const,
                    value,
                    score,
                    accepted: score >= threshold,
                    params: { ...result.params },
                    label: `Finder ${index + 1}`,
                };
                return sample;
            })
            .filter((sample): sample is ParameterAuditSample => sample !== null);
    }

    private async runMiniSensitivityChecks(
        sourceContext: SourceContext,
        data: OHLCVData[],
        preparedData: unknown,
        paramName: string,
        paramLabel: string,
        range: ParameterRange,
        progressFraction: number
    ): Promise<ParameterAuditSample[]> {
        const valuesToTest = this.buildSensitivityValues(
            sourceContext.baseParams[paramName] ?? sourceContext.strategy.defaultParams[paramName],
            range
        );
        if (valuesToTest.length === 0) {
            return [];
        }

        const results: Array<{ value: number; score: number; params: StrategyParams }> = [];
        for (let index = 0; index < valuesToTest.length; index += 1) {
            const testValue = valuesToTest[index];
            const params = this.normalizeStrategyParams(sourceContext.strategy, {
                ...sourceContext.baseParams,
                [paramName]: testValue,
            });
            const signals = sourceContext.strategy.executePrepared && preparedData !== undefined
                ? sourceContext.strategy.executePrepared(preparedData, params, data)
                : sourceContext.strategy.execute(data, params);
            const polarizedSignals = applySignalPolarity(signals, sourceContext.backtestSettings);
            const result = runBacktestCompact(
                data,
                polarizedSignals,
                sourceContext.capitalSettings.initialCapital,
                sourceContext.capitalSettings.positionSize,
                sourceContext.capitalSettings.commission,
                sourceContext.backtestSettings,
                {
                    mode: sourceContext.capitalSettings.sizingMode,
                    fixedTradeAmount: sourceContext.capitalSettings.fixedTradeAmount,
                }
            );
            results.push({
                value: testValue,
                score: computeParameterAuditPerformanceScore(result),
                params,
            });

            const percent = 15 + progressFraction * 75 + ((index + 1) / Math.max(1, valuesToTest.length)) * 6;
            this.setProgress(percent, `Mini-testing ${paramLabel} (${index + 1}/${valuesToTest.length})...`);
            await this.yieldControl();
        }

        const threshold = this.computeMedian(results.map((result) => result.score));
        return results.map((result, index) => ({
            origin: "mini_run" as const,
            value: result.value,
            score: result.score,
            accepted: result.score >= threshold,
            params: result.params,
            label: `Mini run ${index + 1}`,
        }));
    }

    private buildSensitivityValues(baseValue: number, range: ParameterRange): number[] {
        const values = new Set<number>();
        const addValue = (value: number) => {
            const normalized = shouldTreatParamAsWholeNumber(range.name, baseValue)
                ? Math.round(value)
                : Math.round(value * 1000) / 1000;
            const clamped = Math.max(range.min, Math.min(range.max, normalized));
            values.add(clamped);
        };

        addValue(baseValue);
        addValue(range.min);
        addValue(range.max);
        addValue((range.min + range.max) / 2);
        addValue(baseValue - range.step);
        addValue(baseValue + range.step);

        return [...values].sort((left, right) => left - right).slice(0, 5);
    }

    private computeMedian(values: number[]): number {
        const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
        if (sorted.length === 0) return 0;
        const middle = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[middle - 1] + sorted[middle]) / 2;
        }
        return sorted[middle];
    }

    private renderSourcePreview(): void {
        const sourceContext = this.resolveSourceContext();
        if (!sourceContext) {
            return;
        }
        const params = this.getRelevantParamNames(sourceContext.strategy, sourceContext.baseParams);
        this.renderSourceHeader(sourceContext, params);
        this.getDom().parameterAuditSummary.innerHTML = `
            <div class="empty-state empty-state-compact">
                <div class="empty-state-description">Source ready. Run the audit to compute parameter usefulness.</div>
            </div>
        `;
        this.getDom().parameterAuditEmpty.hidden = false;
        this.getDom().parameterAuditEmpty.style.display = "";
    }

    private renderSourceHeader(sourceContext: SourceContext, paramNames: string[]): void {
        const dom = this.getDom();
        const sourceBits = [
            sourceContext.sourceLabel,
            sourceContext.strategyKey,
            `${state.currentSymbol} ${state.currentInterval}`,
        ];
        if (sourceContext.wfaMatch === "exact") {
            sourceBits.push("WFA reuse: exact");
        } else if (sourceContext.wfaMatch === "strategy") {
            sourceBits.push("WFA reuse: same strategy");
        }

        dom.parameterAuditSourceSummary.textContent = sourceBits.join(" | ");
        dom.parameterAuditIncludedParams.textContent = paramNames.length > 0
            ? `Included params: ${paramNames.join(", ")}`
            : "Included params: none";
        dom.parameterAuditEvidence.textContent = sourceContext.notes.join(" ");
    }

    private renderReport(
        report: ParameterAuditReport,
        sourceContext: SourceContext,
        evidenceFlags: { usedMiniRuns: boolean; usedWfaReuse: boolean; usedFinderReuse: boolean }
    ): void {
        const dom = this.getDom();
        dom.parameterAuditEmpty.hidden = true;
        dom.parameterAuditEmpty.style.display = "none";

        const evidenceParts: string[] = [];
        if (evidenceFlags.usedWfaReuse) {
            evidenceParts.push(
                sourceContext.wfaMatch === "exact"
                    ? "reused latest WFA windows"
                    : "reused latest WFA windows for the same strategy"
            );
        }
        if (evidenceFlags.usedFinderReuse) {
            evidenceParts.push("reused Finder candidates");
        }
        if (evidenceFlags.usedMiniRuns) {
            evidenceParts.push("ran targeted mini-runs");
        }
        if (evidenceParts.length === 0) {
            evidenceParts.push("no reusable evidence was available");
        }

        dom.parameterAuditEvidence.textContent = `Evidence: ${evidenceParts.join(", ")}.`;

        dom.parameterAuditSummary.innerHTML = `
            <div class="parameter-audit-summary-grid">
                <div class="parameter-audit-summary-card">
                    <div class="parameter-audit-summary-label">Bloat Assessment</div>
                    <div class="parameter-audit-summary-value">${this.escapeHtml(report.summary.overallParameterBloat)}</div>
                </div>
                <div class="parameter-audit-summary-card">
                    <div class="parameter-audit-summary-label">Simplification Priority</div>
                    <div class="parameter-audit-summary-value">${this.escapeHtml(report.summary.simplificationPriority)}</div>
                </div>
                <div class="parameter-audit-summary-card">
                    <div class="parameter-audit-summary-label">Top Remove/Fix First</div>
                    <div class="parameter-audit-summary-value">${this.escapeHtml(report.summary.topPriorityParams.join(", ") || "None")}</div>
                </div>
                <div class="parameter-audit-summary-card">
                    <div class="parameter-audit-summary-label">Evidence Mode</div>
                    <div class="parameter-audit-summary-value">${this.escapeHtml(report.summary.evidenceMode)}</div>
                </div>
            </div>
            ${report.summary.weakEvidenceWarning ? `
                <div class="parameter-audit-warning">${this.escapeHtml(report.summary.weakEvidenceWarning)}</div>
            ` : ""}
        `;

        dom.parameterAuditTableBody.innerHTML = report.rows.map((row) => `
            <tr>
                <td>
                    <div class="parameter-audit-parameter-name">${this.escapeHtml(row.parameter)}</div>
                    <div class="parameter-audit-parameter-key">${this.escapeHtml(row.key)}</div>
                </td>
                <td>${this.formatNumber(row.baseValue)}</td>
                <td>${this.escapeHtml(row.bestValueCluster)}</td>
                <td>${row.impactScore.toFixed(1)}</td>
                <td>${row.stability.toFixed(1)}%</td>
                <td>${row.boundaryHitPercent.toFixed(1)}%</td>
                <td>${row.rangeOccupancy.toFixed(1)}%</td>
                <td><span class="parameter-audit-pill parameter-audit-pill--${row.classification}">${this.escapeHtml(row.classification)}</span></td>
                <td><span class="parameter-audit-pill parameter-audit-pill--action">${this.escapeHtml(row.suggestedAction)}</span></td>
                <td class="parameter-audit-notes-cell">
                    <div>${this.escapeHtml(row.notes)}</div>
                    <div class="parameter-audit-evidence-strength">Evidence: ${this.escapeHtml(row.evidenceStrength)}</div>
                </td>
            </tr>
        `).join("");
    }

    private formatNumber(value: number): string {
        if (!Number.isFinite(value)) return String(value);
        if (Math.abs(value - Math.round(value)) < 1e-9) {
            return String(Math.round(value));
        }
        return value.toFixed(3).replace(/\.?0+$/, "");
    }

    private escapeHtml(value: string): string {
        return value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    private async yieldControl(): Promise<void> {
        await new Promise<void>((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => resolve();
            channel.port2.postMessage(undefined);
        });
    }
}

export const parameterAuditService = new ParameterAuditService();
