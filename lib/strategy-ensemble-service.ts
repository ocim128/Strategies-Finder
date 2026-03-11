import { strategyRegistry } from "../strategyRegistry";
import { backtestService } from "./backtest-service";
import { sliceOhlcvByBlock } from "./block-selector";
import { trimToClosedCandles } from "./closed-candle-utils";
import { createEnsembleLabDom, type EnsembleLabDom } from "./feature-dom-contracts";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { state } from "./state";
import {
    applySignalPolarity,
    prepareSignalsForScanner,
    timeKey,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Signal,
    type Strategy,
    type StrategyParams,
    type Trade,
} from "./strategies";
import {
    buildPortfolioSignalPresenceLookup,
    resolvePortfolioSignalType,
    type PortfolioSignalPresence,
} from "./portfolio-lab-helpers";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import { getOpenPositionForScanner, type OpenPosition } from "./strategies/backtest/signal-preparation";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";

interface ConfigRunArtifact {
    config: StrategyConfig;
    strategy: Strategy;
    params: StrategyParams;
    rawSignals: Signal[];
    preparedSignals: Signal[];
    signalPresenceByTime: Map<string, PortfolioSignalPresence>;
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
    backtestSettings: BacktestSettings;
}

interface EnsembleTradeSample {
    direction: Trade["type"];
    isWin: boolean;
    pnl: number;
    pnlPercent: number;
    agreeCount: number;
    opposeCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    entryTimeKey: string;
}

interface EnsembleBucketSummary {
    label: string;
    sortValue: number;
    samples: number;
    winRate: number;
    lossRate: number;
    avgExpectancy: number;
    avgNetPct: number;
    avgOppose: number;
    longWinRate: number | null;
    shortWinRate: number | null;
    longSamples: number;
    shortSamples: number;
}

interface EnsembleBuilderRow {
    rule: string;
    signals: number;
    trades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    engineUsed: "rust" | "typescript";
}

interface EnsembleLiveContext {
    basis: "open_trade" | "latest_signal" | "none";
    direction: Trade["type"] | null;
    agreeCount: number;
    opposeCount: number;
    neutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    odds: {
        sampleCount: number;
        winRate: number;
        lossRate: number;
        expectancy: number;
        label: string;
        matchType: "exact" | "nearest";
    } | null;
    openPosition: OpenPosition | null;
}

interface EnsembleRunContext {
    targetConfigName: string;
    contextConfigNames: string[];
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    artifacts: Map<string, ConfigRunArtifact>;
    targetArtifact: ConfigRunArtifact;
    tradeSamples: EnsembleTradeSample[];
    buckets: EnsembleBucketSummary[];
    baselineBucket: EnsembleBucketSummary | null;
    bestBucket: EnsembleBucketSummary | null;
    bestLongBucket: EnsembleBucketSummary | null;
    bestShortBucket: EnsembleBucketSummary | null;
    builderRows: EnsembleBuilderRow[];
    liveContext: EnsembleLiveContext;
    minSamples: number;
}

interface ContextCounts {
    agreeCount: number;
    opposeCount: number;
    neutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
}

interface RadarFinding {
    label: string;
    detail: string;
    quality: "positive" | "negative" | "neutral";
}

class StrategyEnsembleService {
    private dom: EnsembleLabDom | null = null;
    private initialized = false;
    private runContext: EnsembleRunContext | null = null;
    private contextCheckboxes = new Map<string, HTMLInputElement>();

    private getDom(): EnsembleLabDom {
        return this.dom ??= createEnsembleLabDom();
    }

    public init(): void {
        if (this.initialized) {
            return;
        }

        const dom = this.getDom();
        this.bindEvents(dom);
        this.syncReadouts(dom);
        this.populateConfigs(dom);
        this.initialized = true;
    }

    private bindEvents(dom: EnsembleLabDom): void {
        dom.ensembleRunBtn.addEventListener("click", () => {
            void this.run();
        });

        dom.ensembleRefreshConfigsBtn.addEventListener("click", () => {
            this.populateConfigs(dom);
            this.invalidateRunContext("Configs refreshed. Run Strategy Ensemble Lab again.");
        });

        dom.ensembleTargetSelect.addEventListener("change", () => {
            this.invalidateRunContext("Target config changed. Run Strategy Ensemble Lab again.");
        });

        dom.ensembleMinSamples.addEventListener("input", () => {
            this.invalidateRunContext("Minimum sample threshold changed. Run Strategy Ensemble Lab again.");
        });

        state.subscribe("currentSymbol", () => {
            this.syncReadouts(dom);
            this.invalidateRunContext("Target symbol changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("currentInterval", () => {
            this.syncReadouts(dom);
            this.invalidateRunContext("Timeframe changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("ohlcvData", () => {
            this.invalidateRunContext("Loaded data changed. Run Strategy Ensemble Lab again.");
        });
        state.subscribe("blockRange", () => {
            this.invalidateRunContext("Block selection changed. Run Strategy Ensemble Lab again.");
        });
    }

    private syncReadouts(dom: EnsembleLabDom): void {
        dom.ensembleSymbolBadge.textContent = state.currentSymbol;
        dom.ensembleIntervalBadge.textContent = state.currentInterval;
    }

    private populateConfigs(dom: EnsembleLabDom): void {
        const configs = settingsManager.loadAllStrategyConfigs();
        const previousTarget = dom.ensembleTargetSelect.value;

        this.contextCheckboxes.clear();
        dom.ensembleTargetSelect.innerHTML = '<option value="" disabled>Select target config</option>';

        for (const config of configs) {
            const option = document.createElement("option");
            option.value = config.name;
            option.textContent = this.buildConfigLabel(config);
            dom.ensembleTargetSelect.appendChild(option);
        }

        if (previousTarget && configs.some((config) => config.name === previousTarget)) {
            dom.ensembleTargetSelect.value = previousTarget;
        } else if (configs.length > 0) {
            dom.ensembleTargetSelect.value = configs[0].name;
        }

        if (configs.length === 0) {
            dom.ensembleContextList.innerHTML = '<p style="color:var(--text-secondary);padding:8px;margin:0;">No saved configs. Save a strategy configuration first.</p>';
            this.setConfigAvailability(false);
            this.updateStatus("Save strategy configurations, then select a target and context strategies to run ensemble analysis.");
            return;
        }

        dom.ensembleContextList.innerHTML = "";
        for (const config of configs) {
            const row = document.createElement("label");
            row.className = "ensemble-lab__context-item";
            row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border-light, rgba(128,128,128,0.12));border-radius:8px;background:rgba(255,255,255,0.02);cursor:pointer;";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = true;
            checkbox.dataset.configName = config.name;
            checkbox.addEventListener("change", () => {
                this.invalidateRunContext("Context configs changed. Run Strategy Ensemble Lab again.");
            });

            const text = document.createElement("span");
            text.textContent = this.buildConfigLabel(config);
            text.style.fontSize = "12px";

            row.appendChild(checkbox);
            row.appendChild(text);

            this.contextCheckboxes.set(config.name, checkbox);
            dom.ensembleContextList.appendChild(row);
        }

        this.setConfigAvailability(true);
        this.resetResultPanels();
        this.updateStatus("Select a target config, keep one or more context configs, then run Strategy Ensemble Lab.");
    }

    private setConfigAvailability(hasConfigs: boolean): void {
        const dom = this.getDom();
        dom.ensembleEmpty.style.display = hasConfigs ? "none" : "";
        dom.ensembleContent.style.display = hasConfigs ? "" : "none";
    }

    private buildConfigLabel(config: StrategyConfig): string {
        const strategy = strategyRegistry.get(config.strategyKey);
        return `${config.name} (${strategy?.name ?? config.strategyKey})`;
    }

    private getSelectedTargetName(): string {
        return this.getDom().ensembleTargetSelect.value.trim();
    }

    private getSelectedContextNames(): string[] {
        const target = this.getSelectedTargetName();
        const names: string[] = [];
        for (const [name, checkbox] of this.contextCheckboxes.entries()) {
            if (name !== target && checkbox.checked) {
                names.push(name);
            }
        }
        return names;
    }

    private readMinSamples(): number {
        const raw = Number.parseInt(this.getDom().ensembleMinSamples.value, 10);
        if (!Number.isFinite(raw)) {
            return 5;
        }
        return Math.max(3, Math.min(200, raw));
    }

    private invalidateRunContext(message: string): void {
        this.runContext = null;
        this.updateStatus(message);
    }

    private updateStatus(message: string): void {
        this.getDom().ensembleStatus.textContent = message;
    }

    private prepareCandles(): OHLCVData[] {
        if (state.ohlcvData.length < 2) {
            return [];
        }
        return sliceOhlcvByBlock(trimToClosedCandles(state.ohlcvData, state.currentInterval), state.blockRange);
    }

    private async run(): Promise<void> {
        const dom = this.getDom();
        const targetName = this.getSelectedTargetName();

        if (!targetName) {
            uiManager.showToast("Select a target config first.", "error");
            this.updateStatus("Select a target config first.");
            return;
        }

        const contextNames = this.getSelectedContextNames();
        if (contextNames.length === 0) {
            uiManager.showToast("Select at least one context config.", "error");
            this.updateStatus("Select at least one context config.");
            return;
        }

        const candles = this.prepareCandles();
        if (candles.length < 50) {
            uiManager.showToast("Not enough closed candle data loaded. Load more data first.", "error");
            this.updateStatus("Not enough closed candle data to run Strategy Ensemble Lab.");
            return;
        }

        const minSamples = this.readMinSamples();
        const configNames = [targetName, ...contextNames];
        const artifacts = new Map<string, ConfigRunArtifact>();

        dom.ensembleRunBtn.disabled = true;
        dom.ensembleRunBtn.setAttribute("aria-busy", "true");
        this.updateStatus(`Running ${configNames.length} configs on ${state.currentSymbol} (${state.currentInterval})...`);

        try {
            for (let index = 0; index < configNames.length; index += 1) {
                const configName = configNames[index];
                this.updateStatus(`Running ${configName} (${index + 1}/${configNames.length})...`);
                const artifact = await this.runConfig(configName, candles);
                if (artifact) {
                    artifacts.set(configName, artifact);
                }
            }

            const targetArtifact = artifacts.get(targetName);
            if (!targetArtifact) {
                throw new Error(`Target config "${targetName}" could not be evaluated.`);
            }

            const contextArtifacts = contextNames
                .map((name) => artifacts.get(name) ?? null)
                .filter((artifact): artifact is ConfigRunArtifact => artifact !== null);

            if (contextArtifacts.length === 0) {
                throw new Error("No context configs could be evaluated.");
            }

            const tradeSamples = this.buildTradeSamples(targetArtifact, contextArtifacts);
            const buckets = this.buildBuckets(tradeSamples, minSamples);
            const baselineBucket = this.buildBaselineBucket(tradeSamples);
            const bestBucket = this.findBestBucket(buckets, "expectancy");
            const bestLongBucket = this.findBestBucket(
                buckets.filter((bucket) => bucket.longSamples >= minSamples),
                "longWinRate"
            );
            const bestShortBucket = this.findBestBucket(
                buckets.filter((bucket) => bucket.shortSamples >= minSamples),
                "shortWinRate"
            );
            const builderRows = await this.buildEnsembleRows(targetArtifact, contextArtifacts, candles);
            const liveContext = this.buildLiveContext(targetArtifact, contextArtifacts, candles, tradeSamples, minSamples);

            this.runContext = {
                targetConfigName: targetName,
                contextConfigNames: contextArtifacts.map((artifact) => artifact.config.name),
                symbol: state.currentSymbol,
                interval: state.currentInterval,
                candles,
                artifacts,
                targetArtifact,
                tradeSamples,
                buckets,
                baselineBucket,
                bestBucket,
                bestLongBucket,
                bestShortBucket,
                builderRows,
                liveContext,
                minSamples,
            };

            this.renderResults(this.runContext);
            this.updateStatus(
                `Strategy Ensemble Lab ready. ${tradeSamples.length} target trades analyzed across ${contextArtifacts.length} context configs.`
            );
            uiManager.showToast("Strategy Ensemble Lab complete.", "success");
        } catch (error) {
            this.runContext = null;
            console.error("[StrategyEnsembleLab] Run failed", error);
            uiManager.showToast(
                `Strategy Ensemble Lab failed: ${error instanceof Error ? error.message : String(error)}`,
                "error"
            );
            this.updateStatus("Strategy Ensemble Lab failed. Check console for details.");
            this.resetResultPanels();
        } finally {
            dom.ensembleRunBtn.disabled = false;
            dom.ensembleRunBtn.setAttribute("aria-busy", "false");
        }
    }

    private async runConfig(configName: string, candles: OHLCVData[]): Promise<ConfigRunArtifact | null> {
        const config = settingsManager.loadStrategyConfig(configName);
        if (!config) {
            return null;
        }

        const strategy = strategyRegistry.get(config.strategyKey);
        if (!strategy) {
            debugLogger.warn(`[StrategyEnsembleLab] Strategy "${config.strategyKey}" from config "${configName}" is not registered.`);
            return null;
        }

        const params = config.strategyParams ?? strategy.defaultParams;
        const backtestSettings = resolveBacktestSettingsFromRaw(
            config.backtestSettings as unknown as BacktestSettings,
            { captureSnapshots: false, coerceWithoutUiToggles: true }
        );
        const capitalSettings = settingsManager.resolveCapitalFromConfig(config);

        try {
            const runResult = await backtestService.evaluateStrategyOnData(
                candles,
                state.currentInterval,
                strategy,
                params,
                backtestSettings,
                capitalSettings
            );
            const rawSignals = applySignalPolarity(strategy.execute(candles, params), backtestSettings);
            const preparedSignals = prepareSignalsForScanner(candles, rawSignals, backtestSettings);

            return {
                config,
                strategy,
                params,
                rawSignals,
                preparedSignals,
                signalPresenceByTime: buildPortfolioSignalPresenceLookup(preparedSignals),
                result: runResult.result,
                engineUsed: runResult.engineUsed,
                backtestSettings,
            };
        } catch (error) {
            debugLogger.warn(`[StrategyEnsembleLab] Failed to evaluate "${configName}"`, {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private buildTradeSamples(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[]
    ): EnsembleTradeSample[] {
        return targetArtifact.result.trades.map((trade) => {
            const entryTimeKey = timeKey(trade.entryTime);
            const counts = this.buildContextCountsForTimeKey(trade.type, entryTimeKey, contextArtifacts);

            return {
                direction: trade.type,
                isWin: trade.pnl > 0,
                pnl: trade.pnl,
                pnlPercent: trade.pnlPercent,
                agreeCount: counts.agreeCount,
                opposeCount: counts.opposeCount,
                agreeingConfigs: counts.agreeingConfigs,
                opposingConfigs: counts.opposingConfigs,
                entryTimeKey,
            };
        });
    }

    private buildContextCountsForTimeKey(
        direction: Trade["type"],
        entryTimeKey: string,
        contextArtifacts: ConfigRunArtifact[]
    ): ContextCounts {
        const isLong = direction === "long";
        let agreeCount = 0;
        let opposeCount = 0;
        let neutralCount = 0;
        const agreeingConfigs: string[] = [];
        const opposingConfigs: string[] = [];

        for (const artifact of contextArtifacts) {
            const signalType = resolvePortfolioSignalType(artifact.signalPresenceByTime.get(entryTimeKey));
            if (!signalType) {
                neutralCount += 1;
                continue;
            }

            const sameDirection = (signalType === "buy") === isLong;
            if (sameDirection) {
                agreeCount += 1;
                agreeingConfigs.push(artifact.config.name);
            } else {
                opposeCount += 1;
                opposingConfigs.push(artifact.config.name);
            }
        }

        return {
            agreeCount,
            opposeCount,
            neutralCount,
            agreeingConfigs,
            opposingConfigs,
        };
    }

    private buildBuckets(samples: EnsembleTradeSample[], minSamples: number): EnsembleBucketSummary[] {
        if (samples.length === 0) {
            return [];
        }

        const buckets: EnsembleBucketSummary[] = [];
        const maxAgree = Math.max(0, ...samples.map((sample) => sample.agreeCount));
        const maxOppose = Math.max(0, ...samples.map((sample) => sample.opposeCount));

        for (let agree = 0; agree <= maxAgree; agree += 1) {
            const exact = samples.filter((sample) => sample.agreeCount === agree);
            if (exact.length >= minSamples) {
                buckets.push(this.summarizeBucket(`agree = ${agree}`, agree, exact));
            }
        }

        for (let agree = 1; agree <= maxAgree; agree += 1) {
            const cumulative = samples.filter((sample) => sample.agreeCount >= agree);
            if (cumulative.length >= minSamples) {
                buckets.push(this.summarizeBucket(`agree >= ${agree}`, 100 + agree, cumulative));
            }
        }

        for (let oppose = 0; oppose <= maxOppose; oppose += 1) {
            const exact = samples.filter((sample) => sample.opposeCount === oppose);
            if (exact.length >= minSamples) {
                buckets.push(this.summarizeBucket(`oppose = ${oppose}`, -1 - oppose, exact));
            }
        }

        return buckets.sort((left, right) => left.sortValue - right.sortValue);
    }

    private buildBaselineBucket(samples: EnsembleTradeSample[]): EnsembleBucketSummary | null {
        if (samples.length === 0) {
            return null;
        }
        return this.summarizeBucket("baseline (all)", -999, samples);
    }

    private summarizeBucket(
        label: string,
        sortValue: number,
        samples: EnsembleTradeSample[]
    ): EnsembleBucketSummary {
        const wins = samples.filter((sample) => sample.isWin);
        const losses = samples.filter((sample) => !sample.isWin);
        const longSamples = samples.filter((sample) => sample.direction === "long");
        const shortSamples = samples.filter((sample) => sample.direction === "short");
        const longWins = longSamples.filter((sample) => sample.isWin);
        const shortWins = shortSamples.filter((sample) => sample.isWin);

        return {
            label,
            sortValue,
            samples: samples.length,
            winRate: (wins.length / samples.length) * 100,
            lossRate: (losses.length / samples.length) * 100,
            avgExpectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
            avgNetPct: samples.reduce((sum, sample) => sum + sample.pnlPercent, 0) / samples.length,
            avgOppose: samples.reduce((sum, sample) => sum + sample.opposeCount, 0) / samples.length,
            longWinRate: longSamples.length >= 3 ? (longWins.length / longSamples.length) * 100 : null,
            shortWinRate: shortSamples.length >= 3 ? (shortWins.length / shortSamples.length) * 100 : null,
            longSamples: longSamples.length,
            shortSamples: shortSamples.length,
        };
    }

    private findBestBucket(
        buckets: EnsembleBucketSummary[],
        metric: "expectancy" | "longWinRate" | "shortWinRate"
    ): EnsembleBucketSummary | null {
        if (buckets.length === 0) {
            return null;
        }

        return buckets.reduce((best, current) => {
            const bestValue = metric === "expectancy" ? best.avgExpectancy : (best[metric] ?? Number.NEGATIVE_INFINITY);
            const currentValue = metric === "expectancy" ? current.avgExpectancy : (current[metric] ?? Number.NEGATIVE_INFINITY);
            return currentValue > bestValue ? current : best;
        });
    }

    private async buildEnsembleRows(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[]
    ): Promise<EnsembleBuilderRow[]> {
        const rows: EnsembleBuilderRow[] = [
            this.buildResultRow(
                "Baseline (target only)",
                targetArtifact.result,
                targetArtifact.preparedSignals.length,
                targetArtifact.engineUsed
            ),
        ];

        if (contextArtifacts.length === 0) {
            return rows;
        }

        const maxContext = contextArtifacts.length;

        for (let minAgree = 1; minAgree <= Math.min(maxContext, 5); minAgree += 1) {
            const filteredSignals = this.filterPreparedSignals(targetArtifact, contextArtifacts, minAgree, null);
            const evaluated = await this.runFilteredBacktest(targetArtifact, filteredSignals, candles);
            if (evaluated) {
                rows.push(this.buildResultRow(`minAgree >= ${minAgree}`, evaluated.result, filteredSignals.length, evaluated.engineUsed));
            }
        }

        for (let maxOppose = 0; maxOppose <= Math.min(maxContext, 3); maxOppose += 1) {
            const filteredSignals = this.filterPreparedSignals(targetArtifact, contextArtifacts, 0, maxOppose);
            const evaluated = await this.runFilteredBacktest(targetArtifact, filteredSignals, candles);
            if (evaluated) {
                rows.push(this.buildResultRow(`maxOppose <= ${maxOppose}`, evaluated.result, filteredSignals.length, evaluated.engineUsed));
            }
        }

        for (let minAgree = 1; minAgree <= Math.min(maxContext, 3); minAgree += 1) {
            for (let maxOppose = 0; maxOppose <= Math.min(maxContext, 2); maxOppose += 1) {
                const filteredSignals = this.filterPreparedSignals(targetArtifact, contextArtifacts, minAgree, maxOppose);
                const evaluated = await this.runFilteredBacktest(targetArtifact, filteredSignals, candles);
                if (evaluated) {
                    rows.push(this.buildResultRow(
                        `agree >= ${minAgree} + oppose <= ${maxOppose}`,
                        evaluated.result,
                        filteredSignals.length,
                        evaluated.engineUsed
                    ));
                }
            }
        }

        for (let k = 2; k <= Math.min(maxContext + 1, 4); k += 1) {
            const consensusSignals = this.buildKofNConsensusSignals(targetArtifact, contextArtifacts, k);
            const evaluated = await this.runFilteredBacktest(targetArtifact, consensusSignals, candles);
            if (evaluated) {
                rows.push(this.buildResultRow(
                    `${k}-of-${maxContext + 1} consensus`,
                    evaluated.result,
                    consensusSignals.length,
                    evaluated.engineUsed
                ));
            }
        }

        const vetoSignals = this.filterPreparedSignals(targetArtifact, contextArtifacts, 0, 0);
        const vetoResult = await this.runFilteredBacktest(targetArtifact, vetoSignals, candles);
        if (vetoResult) {
            rows.push(this.buildResultRow("Veto (no opposition)", vetoResult.result, vetoSignals.length, vetoResult.engineUsed));
        }

        return this.dedupeBuilderRows(rows);
    }

    private filterPreparedSignals(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        minAgree: number,
        maxOppose: number | null
    ): Signal[] {
        return targetArtifact.preparedSignals.filter((signal) => {
            const signalDirection = signal.type === "buy" ? "long" : "short";
            const counts = this.buildContextCountsForTimeKey(signalDirection, timeKey(signal.time), contextArtifacts);
            if (counts.agreeCount < minAgree) {
                return false;
            }
            if (typeof maxOppose === "number" && counts.opposeCount > maxOppose) {
                return false;
            }
            return true;
        });
    }

    private buildKofNConsensusSignals(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        k: number
    ): Signal[] {
        const artifacts = [targetArtifact, ...contextArtifacts];
        const timeKeys = new Set<string>();

        for (const artifact of artifacts) {
            for (const key of artifact.signalPresenceByTime.keys()) {
                timeKeys.add(key);
            }
        }

        const consensusSignals: Signal[] = [];
        for (const key of timeKeys) {
            let buyCount = 0;
            let sellCount = 0;
            let buySignal: Signal | null = null;
            let sellSignal: Signal | null = null;

            for (const artifact of artifacts) {
                const signalType = resolvePortfolioSignalType(artifact.signalPresenceByTime.get(key));
                if (signalType === "buy") {
                    buyCount += 1;
                    buySignal ??= artifact.preparedSignals.find((signal) => timeKey(signal.time) === key && signal.type === "buy") ?? null;
                } else if (signalType === "sell") {
                    sellCount += 1;
                    sellSignal ??= artifact.preparedSignals.find((signal) => timeKey(signal.time) === key && signal.type === "sell") ?? null;
                }
            }

            if (buyCount >= k && sellCount >= k) {
                continue;
            }
            if (buyCount >= k && buySignal) {
                consensusSignals.push({ ...buySignal, type: "buy" });
            } else if (sellCount >= k && sellSignal) {
                consensusSignals.push({ ...sellSignal, type: "sell" });
            }
        }

        consensusSignals.sort((left, right) => {
            const leftBarIndex = Number.isFinite(left.barIndex as number) ? Math.trunc(left.barIndex as number) : Number.MAX_SAFE_INTEGER;
            const rightBarIndex = Number.isFinite(right.barIndex as number) ? Math.trunc(right.barIndex as number) : Number.MAX_SAFE_INTEGER;
            if (leftBarIndex !== rightBarIndex) {
                return leftBarIndex - rightBarIndex;
            }
            return timeKey(left.time).localeCompare(timeKey(right.time));
        });

        return consensusSignals;
    }

    private async runFilteredBacktest(
        targetArtifact: ConfigRunArtifact,
        signals: Signal[],
        candles: OHLCVData[]
    ): Promise<{ result: BacktestResult; engineUsed: "rust" | "typescript" } | null> {
        if (signals.length < 2) {
            return null;
        }

        try {
            return await backtestService.evaluateSignalsOnData(
                candles,
                state.currentInterval,
                signals,
                targetArtifact.backtestSettings,
                settingsManager.resolveCapitalFromConfig(targetArtifact.config)
            );
        } catch (error) {
            debugLogger.warn("[StrategyEnsembleLab] Filtered backtest failed", {
                config: targetArtifact.config.name,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private buildResultRow(
        rule: string,
        result: BacktestResult,
        signals: number,
        engineUsed: "rust" | "typescript"
    ): EnsembleBuilderRow {
        return {
            rule,
            signals,
            trades: result.totalTrades,
            winRate: result.winRate,
            netProfitPercent: result.netProfitPercent,
            expectancy: result.expectancy,
            profitFactor: result.profitFactor,
            maxDrawdownPercent: result.maxDrawdownPercent,
            engineUsed,
        };
    }

    private dedupeBuilderRows(rows: EnsembleBuilderRow[]): EnsembleBuilderRow[] {
        const seen = new Set<string>();
        const deduped: EnsembleBuilderRow[] = [];

        for (const row of rows) {
            const signature = [
                row.signals,
                row.trades,
                row.winRate.toFixed(6),
                row.netProfitPercent.toFixed(6),
                row.expectancy.toFixed(6),
                row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(6),
                row.maxDrawdownPercent.toFixed(6),
                row.engineUsed,
            ].join("|");

            if (seen.has(signature)) {
                continue;
            }

            seen.add(signature);
            deduped.push(row);
        }

        return deduped;
    }

    private buildLiveContext(
        targetArtifact: ConfigRunArtifact,
        contextArtifacts: ConfigRunArtifact[],
        candles: OHLCVData[],
        tradeSamples: EnsembleTradeSample[],
        minSamples: number
    ): EnsembleLiveContext {
        const openPosition = getOpenPositionForScanner(candles, targetArtifact.rawSignals, targetArtifact.backtestSettings);
        const latestPreparedSignal = targetArtifact.preparedSignals[targetArtifact.preparedSignals.length - 1] ?? null;

        let basis: EnsembleLiveContext["basis"] = "none";
        let direction: Trade["type"] | null = null;
        let contextTimeKey: string | null = null;

        if (openPosition) {
            basis = "open_trade";
            direction = openPosition.direction;
            contextTimeKey = timeKey(openPosition.entryTime);
        } else if (latestPreparedSignal) {
            basis = "latest_signal";
            direction = latestPreparedSignal.type === "buy" ? "long" : "short";
            contextTimeKey = timeKey(latestPreparedSignal.time);
        }

        if (!direction || !contextTimeKey) {
            return {
                basis: "none",
                direction: null,
                agreeCount: 0,
                opposeCount: 0,
                neutralCount: contextArtifacts.length,
                agreeingConfigs: [],
                opposingConfigs: [],
                odds: null,
                openPosition,
            };
        }

        const counts = this.buildContextCountsForTimeKey(direction, contextTimeKey, contextArtifacts);
        const matchingSamples = tradeSamples.filter(
            (sample) => sample.direction === direction
                && sample.agreeCount === counts.agreeCount
                && sample.opposeCount === counts.opposeCount
        );

        let odds: EnsembleLiveContext["odds"] = null;
        if (matchingSamples.length >= Math.max(3, minSamples)) {
            const wins = matchingSamples.filter((sample) => sample.isWin).length;
            odds = {
                sampleCount: matchingSamples.length,
                winRate: (wins / matchingSamples.length) * 100,
                lossRate: 100 - (wins / matchingSamples.length) * 100,
                expectancy: matchingSamples.reduce((sum, sample) => sum + sample.pnl, 0) / matchingSamples.length,
                label: `${direction} | agree=${counts.agreeCount}, oppose=${counts.opposeCount}`,
                matchType: "exact",
            };
        } else {
            odds = this.findNearestContextOdds(
                tradeSamples,
                direction,
                counts.agreeCount,
                counts.opposeCount,
                minSamples
            );
        }

        return {
            basis,
            direction,
            agreeCount: counts.agreeCount,
            opposeCount: counts.opposeCount,
            neutralCount: counts.neutralCount,
            agreeingConfigs: counts.agreeingConfigs,
            opposingConfigs: counts.opposingConfigs,
            odds,
            openPosition,
        };
    }

    private findNearestContextOdds(
        samples: EnsembleTradeSample[],
        direction: Trade["type"],
        agreeCount: number,
        opposeCount: number,
        minSamples: number
    ): EnsembleLiveContext["odds"] {
        const grouped = new Map<string, EnsembleTradeSample[]>();

        for (const sample of samples) {
            if (sample.direction !== direction) {
                continue;
            }
            const key = `${sample.agreeCount}|${sample.opposeCount}`;
            const bucket = grouped.get(key);
            if (bucket) {
                bucket.push(sample);
            } else {
                grouped.set(key, [sample]);
            }
        }

        let best:
            | {
                agreeCount: number;
                opposeCount: number;
                samples: EnsembleTradeSample[];
                distance: number;
            }
            | null = null;

        for (const [key, bucket] of grouped.entries()) {
            if (bucket.length < Math.max(3, minSamples)) {
                continue;
            }
            const [bucketAgreeRaw, bucketOpposeRaw] = key.split("|");
            const bucketAgree = Number.parseInt(bucketAgreeRaw, 10);
            const bucketOppose = Number.parseInt(bucketOpposeRaw, 10);
            const distance = Math.abs(bucketAgree - agreeCount) + Math.abs(bucketOppose - opposeCount);

            if (!best) {
                best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
                continue;
            }

            if (distance !== best.distance) {
                if (distance < best.distance) {
                    best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
                }
                continue;
            }

            if (bucket.length > best.samples.length) {
                best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
            }
        }

        if (!best) {
            return null;
        }

        const wins = best.samples.filter((sample) => sample.isWin).length;
        return {
            sampleCount: best.samples.length,
            winRate: (wins / best.samples.length) * 100,
            lossRate: 100 - (wins / best.samples.length) * 100,
            expectancy: best.samples.reduce((sum, sample) => sum + sample.pnl, 0) / best.samples.length,
            label: `${direction} | agree=${best.agreeCount}, oppose=${best.opposeCount}`,
            matchType: "nearest",
        };
    }

    private buildRadarFindings(context: EnsembleRunContext): RadarFinding[] {
        const findings: RadarFinding[] = [];
        const baseline = context.baselineBucket;
        const radarMinSamples = Math.max(context.minSamples * 3, 20);

        if (!baseline) {
            return [
                {
                    label: "No actionable findings",
                    detail: "The ensemble analysis did not produce enough target trades for higher-confidence signals.",
                    quality: "neutral",
                },
            ];
        }

        if (context.bestBucket && context.bestBucket.samples >= radarMinSamples && baseline.avgExpectancy !== 0) {
            const lift = ((context.bestBucket.avgExpectancy - baseline.avgExpectancy) / Math.abs(baseline.avgExpectancy)) * 100;
            if (Number.isFinite(lift) && lift > 10) {
                findings.push({
                    label: "Strongest expectancy lift",
                    detail: `"${context.bestBucket.label}" improves expectancy by ${lift.toFixed(1)}% vs baseline (${context.bestBucket.samples} samples).`,
                    quality: "positive",
                });
            }
        }

        const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)");
        const bestDrawdownRow = context.builderRows
            .filter((row) => row.rule !== "Baseline (target only)" && row.trades >= radarMinSamples)
            .sort((left, right) => Math.abs(left.maxDrawdownPercent) - Math.abs(right.maxDrawdownPercent))[0];
        if (baselineRow && bestDrawdownRow && Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent) * 0.8) {
            const reduction = ((Math.abs(baselineRow.maxDrawdownPercent) - Math.abs(bestDrawdownRow.maxDrawdownPercent)) / Math.abs(baselineRow.maxDrawdownPercent)) * 100;
            findings.push({
                label: "Strongest drawdown reduction",
                detail: `"${bestDrawdownRow.rule}" reduces max drawdown by ${reduction.toFixed(1)}% vs baseline.`,
                quality: "positive",
            });
        }

        const trapBucket = context.buckets.find((bucket) => bucket.label.startsWith("agree >=") && bucket.avgExpectancy < 0 && bucket.samples >= radarMinSamples);
        if (trapBucket) {
            findings.push({
                label: "Consensus trap",
                detail: `"${trapBucket.label}" still has negative expectancy ($${trapBucket.avgExpectancy.toFixed(2)}). High agreement is not always good.`,
                quality: "negative",
            });
        }

        const rareBucket = context.buckets.find((bucket) =>
            bucket.samples >= radarMinSamples
            && bucket.samples <= baseline.samples * 0.15
            && bucket.winRate > baseline.winRate + 15
            && bucket.avgExpectancy > 0
        );
        if (rareBucket) {
            findings.push({
                label: "Rare high-value bucket",
                detail: `"${rareBucket.label}" is low frequency (${rareBucket.samples} trades) but materially outperforms baseline.`,
                quality: "positive",
            });
        }

        const oppositionBucket = context.buckets.find((bucket) => {
            if (!bucket.label.startsWith("oppose = ")) {
                return false;
            }
            const opposeValue = Number.parseInt(bucket.label.replace("oppose = ", ""), 10);
            return opposeValue >= 2 && bucket.avgExpectancy > 0 && bucket.samples >= radarMinSamples;
        });
        if (oppositionBucket) {
            findings.push({
                label: "Opposition still profitable",
                detail: `"${oppositionBucket.label}" remains positive expectancy ($${oppositionBucket.avgExpectancy.toFixed(2)}). Opposition does not automatically invalidate the target.`,
                quality: "neutral",
            });
        }

        if (findings.length === 0) {
            findings.push({
                label: "No strong anomaly found",
                detail: "The current config set did not surface a strong consensus edge or trap from the available data.",
                quality: "neutral",
            });
        }

        return findings;
    }

    private renderResults(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const hasTrades = context.tradeSamples.length > 0;

        dom.ensembleResults.style.display = hasTrades ? "" : "none";
        dom.ensembleCurrentContextSection.style.display = hasTrades ? "" : "none";
        dom.ensembleHistoricalOddsSection.style.display = hasTrades ? "" : "none";
        dom.ensembleBuilderSection.style.display = hasTrades ? "" : "none";
        dom.ensembleRadarSection.style.display = hasTrades ? "" : "none";

        if (!hasTrades) {
            this.resetResultPanels();
            dom.ensembleResults.style.display = "";
            dom.ensembleSummary.innerHTML = this.card("Status", "No target trades found");
            return;
        }

        this.renderSummary(context);
        this.renderCurrentContext(context);
        this.renderHistoricalOdds(context);
        this.renderBuilder(context);
        this.renderRadar(context);
    }

    private resetResultPanels(): void {
        const dom = this.getDom();
        dom.ensembleResults.style.display = "none";
        dom.ensembleCurrentContextSection.style.display = "none";
        dom.ensembleHistoricalOddsSection.style.display = "none";
        dom.ensembleBuilderSection.style.display = "none";
        dom.ensembleRadarSection.style.display = "none";

        dom.ensembleSummary.innerHTML = "";
        dom.ensembleCurrentContextSummary.innerHTML = "";
        dom.ensembleCurrentContextDetails.innerHTML = "";
        dom.ensembleHistoricalOddsSummary.innerHTML = "";
        dom.ensembleHistoricalOddsTableBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to calculate conditional outcome probabilities.
                </td>
            </tr>
        `;
        dom.ensembleBuilderSummary.innerHTML = "";
        dom.ensembleBuilderTableBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Strategy Ensemble Lab to compare ensemble filtering rules.
                </td>
            </tr>
        `;
        dom.ensembleRadarContent.innerHTML = "";
    }

    private renderSummary(context: EnsembleRunContext): void {
        const targetResult = context.targetArtifact.result;
        this.getDom().ensembleSummary.innerHTML = [
            this.card("Target Config", context.targetConfigName),
            this.card("Strategy", context.targetArtifact.strategy.name),
            this.card("Context Configs", String(context.contextConfigNames.length)),
            this.card("Target Trades", String(targetResult.totalTrades)),
            this.card("Win Rate", `${targetResult.winRate.toFixed(1)}%`),
            this.card("Expectancy", `$${targetResult.expectancy.toFixed(2)}`),
            this.card("Net %", `${targetResult.netProfitPercent.toFixed(2)}%`),
            this.card("Engine", context.targetArtifact.engineUsed),
        ].join("");
    }

    private renderCurrentContext(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const liveContext = context.liveContext;

        if (liveContext.basis === "none" || !liveContext.direction) {
            dom.ensembleCurrentContextSummary.innerHTML = this.card("Status", "No actionable current context");
            dom.ensembleCurrentContextDetails.innerHTML = '<div class="portfolio-lab__insight">The target config has no open trade and no latest actionable signal on the loaded closed-candle window.</div>';
            return;
        }

        const cards = [
            this.card("Basis", liveContext.basis === "open_trade" ? "Open trade" : "Latest signal"),
            this.card("Direction", liveContext.direction === "long" ? "Long" : "Short"),
            this.card("Agreement", String(liveContext.agreeCount)),
            this.card("Opposition", String(liveContext.opposeCount)),
            this.card("Neutral", String(liveContext.neutralCount)),
        ];

        if (liveContext.openPosition) {
            cards.push(this.card("Bars In Trade", String(liveContext.openPosition.barsInTrade)));
            cards.push(this.card("uPnL %", `${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}%`));
        }
        if (liveContext.odds) {
            cards.push(this.card("Historical Win Rate", `${liveContext.odds.winRate.toFixed(1)}%`));
            cards.push(this.card("Historical Expectancy", `$${liveContext.odds.expectancy.toFixed(2)}`));
        }
        const recommendation = this.resolveLiveRecommendation(context, liveContext);
        if (recommendation) {
            cards.push(this.card("Recommended Filter", recommendation.summary));
        }

        dom.ensembleCurrentContextSummary.innerHTML = cards.join("");

        const details: string[] = [];
        if (liveContext.agreeingConfigs.length > 0) {
            details.push(`<div class="portfolio-lab__insight positive">Agreeing: <strong>${this.escapeHtml(liveContext.agreeingConfigs.join(", "))}</strong></div>`);
        }
        if (liveContext.opposingConfigs.length > 0) {
            details.push(`<div class="portfolio-lab__insight negative">Opposing: <strong>${this.escapeHtml(liveContext.opposingConfigs.join(", "))}</strong></div>`);
        }
        if (liveContext.odds) {
            details.push(
                `<div class="portfolio-lab__insight">Historical ${liveContext.odds.matchType === "exact" ? "odds" : "nearest-bucket odds"} for <strong>${this.escapeHtml(liveContext.odds.label)}</strong>: ${liveContext.odds.winRate.toFixed(1)}% win rate, $${liveContext.odds.expectancy.toFixed(2)} expectancy, ${liveContext.odds.sampleCount} samples.</div>`
            );
        } else {
            details.push('<div class="portfolio-lab__insight">No exact or nearby historical bucket met the minimum sample threshold for the current context.</div>');
        }
        if (recommendation) {
            details.push(`<div class="portfolio-lab__insight ${recommendation.passes ? "positive" : "negative"}">${this.escapeHtml(recommendation.detail)}</div>`);
        }

        dom.ensembleCurrentContextDetails.innerHTML = details.join("");
    }

    private resolveLiveRecommendation(
        context: EnsembleRunContext,
        liveContext: EnsembleLiveContext
    ): { summary: string; detail: string; passes: boolean } | null {
        const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)") ?? null;
        const candidateRows = context.builderRows.filter((row) => row.rule !== "Baseline (target only)");
        const bestBalanceRow = baselineRow
            ? candidateRows
                .filter((row) => row.trades >= baselineRow.trades * 0.5 && row.expectancy >= baselineRow.expectancy)
                .reduce<EnsembleBuilderRow | null>((best, row) => {
                    if (!best) {
                        return row;
                    }
                    if (row.expectancy !== best.expectancy) {
                        return row.expectancy > best.expectancy ? row : best;
                    }
                    return row.trades > best.trades ? row : best;
                }, null)
            : null;
        const row = bestBalanceRow
            ?? candidateRows.reduce<EnsembleBuilderRow | null>((best, current) => {
                if (!best) {
                    return current;
                }
                return current.expectancy > best.expectancy ? current : best;
            }, null);

        if (!row) {
            return null;
        }

        const evaluation = this.evaluateRuleAgainstContext(row.rule, liveContext.agreeCount, liveContext.opposeCount);
        return {
            summary: `${row.rule} (${evaluation.passes ? "PASS" : "BLOCK"})`,
            detail: `Recommended live filter is "${row.rule}". Current context ${evaluation.passes ? "passes" : "fails"} because agree=${liveContext.agreeCount}, oppose=${liveContext.opposeCount}.`,
            passes: evaluation.passes,
        };
    }

    private evaluateRuleAgainstContext(
        rule: string,
        agreeCount: number,
        opposeCount: number
    ): { passes: boolean } {
        const combinedMatch = rule.match(/agree >= (\d+) \+ oppose <= (\d+)/);
        if (combinedMatch) {
            const minAgree = Number.parseInt(combinedMatch[1], 10);
            const maxOppose = Number.parseInt(combinedMatch[2], 10);
            return { passes: agreeCount >= minAgree && opposeCount <= maxOppose };
        }

        const minAgreeMatch = rule.match(/minAgree >= (\d+)/);
        if (minAgreeMatch) {
            return { passes: agreeCount >= Number.parseInt(minAgreeMatch[1], 10) };
        }

        const maxOpposeMatch = rule.match(/maxOppose <= (\d+)/);
        if (maxOpposeMatch) {
            return { passes: opposeCount <= Number.parseInt(maxOpposeMatch[1], 10) };
        }

        if (rule === "Veto (no opposition)") {
            return { passes: opposeCount === 0 };
        }

        return { passes: true };
    }

    private renderHistoricalOdds(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const rows = [context.baselineBucket, ...context.buckets].filter(
            (bucket): bucket is EnsembleBucketSummary => bucket !== null
        );

        if (rows.length === 0) {
            dom.ensembleHistoricalOddsSummary.innerHTML = this.card("Status", "No qualifying buckets");
            dom.ensembleHistoricalOddsTableBody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                        Not enough samples to produce conditional odds.
                    </td>
                </tr>
            `;
            return;
        }

        const summaryCards: string[] = [];
        if (context.bestBucket) {
            summaryCards.push(this.card(
                "Best Bucket",
                `${context.bestBucket.label} ($${context.bestBucket.avgExpectancy.toFixed(2)}, n=${context.bestBucket.samples})`
            ));
        }
        if (context.bestLongBucket) {
            summaryCards.push(this.card(
                "Best Long Bucket",
                `${context.bestLongBucket.label} (${context.bestLongBucket.longWinRate?.toFixed(1)}%, n=${context.bestLongBucket.longSamples})`
            ));
        }
        if (context.bestShortBucket) {
            summaryCards.push(this.card(
                "Best Short Bucket",
                `${context.bestShortBucket.label} (${context.bestShortBucket.shortWinRate?.toFixed(1)}%, n=${context.bestShortBucket.shortSamples})`
            ));
        }
        dom.ensembleHistoricalOddsSummary.innerHTML = summaryCards.join("");

        dom.ensembleHistoricalOddsTableBody.innerHTML = rows.map((bucket) => {
            const isBaseline = bucket.label === "baseline (all)";
            const isBest = context.bestBucket?.label === bucket.label;
            const rowStyle = isBaseline
                ? ' style="font-weight:600;background:var(--bg-secondary);"'
                : isBest
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(bucket.label)}</td>
                    <td>${bucket.samples}</td>
                    <td>${bucket.winRate.toFixed(1)}%</td>
                    <td>${bucket.lossRate.toFixed(1)}%</td>
                    <td>$${bucket.avgExpectancy.toFixed(2)}</td>
                    <td>${bucket.avgNetPct.toFixed(2)}%</td>
                    <td>${bucket.avgOppose.toFixed(2)}</td>
                    <td>${bucket.longWinRate === null ? "-" : `${bucket.longWinRate.toFixed(1)}%`}</td>
                    <td>${bucket.shortWinRate === null ? "-" : `${bucket.shortWinRate.toFixed(1)}%`}</td>
                </tr>
            `;
        }).join("");
    }

    private renderBuilder(context: EnsembleRunContext): void {
        const dom = this.getDom();
        const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)") ?? context.builderRows[0] ?? null;
        const nonBaselineRows = context.builderRows.filter((row) => row.rule !== "Baseline (target only)" && row.trades >= context.minSamples);
        const bestExpectancyRow = nonBaselineRows.length > 0
            ? nonBaselineRows.reduce((best, row) => row.expectancy > best.expectancy ? row : best)
            : null;
        const bestDrawdownRow = nonBaselineRows.length > 0
            ? nonBaselineRows.reduce((best, row) => Math.abs(row.maxDrawdownPercent) < Math.abs(best.maxDrawdownPercent) ? row : best)
            : null;
        const bestBalanceRow = baselineRow
            ? nonBaselineRows
                .filter((row) => row.trades >= baselineRow.trades * 0.5 && row.expectancy >= baselineRow.expectancy)
                .reduce<EnsembleBuilderRow | null>((best, row) => {
                    if (!best) {
                        return row;
                    }
                    if (row.expectancy !== best.expectancy) {
                        return row.expectancy > best.expectancy ? row : best;
                    }
                    return row.trades > best.trades ? row : best;
                }, null)
            : null;

        const summaryCards: string[] = [];
        if (bestExpectancyRow) {
            summaryCards.push(this.card("Best Expectancy", `${bestExpectancyRow.rule} ($${bestExpectancyRow.expectancy.toFixed(2)})`));
        }
        if (bestDrawdownRow) {
            const beatsBaseline = baselineRow
                ? Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent)
                : false;
            summaryCards.push(this.card(
                beatsBaseline ? "Best Max DD" : "Best Filtered Max DD",
                `${bestDrawdownRow.rule} (${bestDrawdownRow.maxDrawdownPercent.toFixed(1)}%)`
            ));
        }
        if (bestBalanceRow && baselineRow) {
            summaryCards.push(this.card(
                "Best Balance",
                `${bestBalanceRow.rule} (${((bestBalanceRow.trades / baselineRow.trades) * 100).toFixed(0)}% trades, $${bestBalanceRow.expectancy.toFixed(2)})`
            ));
        }
        dom.ensembleBuilderSummary.innerHTML = summaryCards.join("");

        dom.ensembleBuilderTableBody.innerHTML = context.builderRows.map((row) => {
            const isBaseline = row.rule === "Baseline (target only)";
            const isBest = bestExpectancyRow?.rule === row.rule;
            const rowStyle = isBaseline
                ? ' style="font-weight:600;background:var(--bg-secondary);"'
                : isBest
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";

            return `
                <tr${rowStyle}>
                    <td>${this.escapeHtml(row.rule)}</td>
                    <td>${row.signals}</td>
                    <td>${row.trades}</td>
                    <td>${row.winRate.toFixed(1)}%</td>
                    <td>${row.netProfitPercent.toFixed(2)}%</td>
                    <td>$${row.expectancy.toFixed(2)}</td>
                    <td>${row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(2)}</td>
                    <td>${row.maxDrawdownPercent.toFixed(1)}%</td>
                    <td>${row.engineUsed}</td>
                </tr>
            `;
        }).join("");
    }

    private renderRadar(context: EnsembleRunContext): void {
        const findings = this.buildRadarFindings(context);
        this.getDom().ensembleRadarContent.innerHTML = findings.map((finding) => {
            const className = finding.quality === "positive" ? "positive" : finding.quality === "negative" ? "negative" : "";
            return `<div class="portfolio-lab__insight ${className}"><strong>${this.escapeHtml(finding.label)}</strong>: ${this.escapeHtml(finding.detail)}</div>`;
        }).join("");
    }

    private card(label: string, value: string): string {
        return `
            <div class="sim-card">
                <div class="sim-card-label">${this.escapeHtml(label)}</div>
                <div class="sim-card-value">${this.escapeHtml(value)}</div>
            </div>
        `;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export const strategyEnsembleService = new StrategyEnsembleService();
