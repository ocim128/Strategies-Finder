import { strategyRegistry } from "../../strategyRegistry";
import { backtestService } from "../backtest-service";
import {
    getCurrentUiBacktestEndpointCandles,
    getCurrentUiBacktestEndpointSnapshot,
} from "../backtest-endpoint-copy";
import { sliceOhlcvByBlock } from "../block-selector";
import { dataManager } from "../data-manager";
import { FinderParamSpace } from "../finder/finder-param-space";
import { runFinderExecution, type FinderSelectedStrategy } from "../finder/finder-runner";
import { resolveBacktestSettingsFromRaw } from "../backtest-settings-resolver";
import { paramManager } from "../param-manager";
import { settingsManager } from "../settings-manager";
import { clearBacktestResults, commitBacktestResult, setBlockRange, setCurrentStrategyKey } from "../state-actions";
import { state } from "../state";
import { isSmartTradeSizingMode } from "../types/backtest";
import type { FinderOptions, FinderMetric } from "../types/finder";
import type { BacktestResult, StrategyParams } from "../types/strategies";
import { buildHuntFinderOptions, getHuntPrimaryMetric, groupHuntSurvivors, sortHuntProfileResults, tagProfileResults } from "./hunt-results";
import {
    cloneBlockRange,
    cloneCapitalSettings,
    cloneHuntRunSettings,
    getMarketSelectionAutoReloadSuppressCount,
    type HuntProfile,
    type HuntProfileRunResult,
    type HuntRunSettings,
    type HuntSurvivorGroup,
} from "./hunt-model";

export interface HuntRunMessage {
    level: "info" | "warning" | "error";
    text: string;
}

export interface HuntRunProgress {
    percent: number;
    status: string;
    currentProfileLabel: string;
    currentStrategyLabel: string;
    processedProfiles: number;
    totalProfiles: number;
    processedStrategies: number;
    totalStrategies: number;
}

export interface HuntRunOutput {
    runSettings: HuntRunSettings;
    finderOptions: FinderOptions;
    primaryMetric: FinderMetric;
    profileResults: HuntProfileRunResult[];
    survivors: HuntSurvivorGroup[];
    messages: HuntRunMessage[];
    cancelled: boolean;
}

export interface HuntRunController {
    run: () => Promise<HuntRunOutput>;
    cancel: () => void;
}

interface HuntOriginalUiContext {
    symbol: string;
    interval: string;
    blockRange: { from: number; to: number } | null;
    backtestSettings: ReturnType<typeof settingsManager.getBacktestSettings>;
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestResult: BacktestResult | null;
    backtestResultSource: typeof state.currentBacktestResultSource;
    endpointSnapshot: ReturnType<typeof getCurrentUiBacktestEndpointSnapshot>;
    endpointCandles: ReturnType<typeof getCurrentUiBacktestEndpointCandles>;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function captureOriginalUiContext(): HuntOriginalUiContext {
    const currentStrategy = strategyRegistry.get(state.currentStrategyKey);

    return {
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        blockRange: cloneBlockRange(state.blockRange),
        backtestSettings: cloneJson(settingsManager.getBacktestSettings()),
        strategyKey: state.currentStrategyKey,
        strategyParams: currentStrategy ? cloneJson(paramManager.getValues(currentStrategy)) : {},
        backtestResult: state.currentBacktestResult ? cloneJson(state.currentBacktestResult) : null,
        backtestResultSource: state.currentBacktestResultSource,
        endpointSnapshot: getCurrentUiBacktestEndpointSnapshot(),
        endpointCandles: getCurrentUiBacktestEndpointCandles(),
    };
}

async function applyUiContext(input: {
    symbol: string;
    interval: string;
    blockRange: { from: number; to: number } | null;
    backtestSettings: ReturnType<typeof settingsManager.getBacktestSettings>;
    strategyKey?: string;
    strategyParams?: StrategyParams;
    temporary?: boolean;
}): Promise<void> {
    const work = async () => {
        settingsManager.applyBacktestSettings(input.backtestSettings);
        dataManager.suppressNextAutoReload(getMarketSelectionAutoReloadSuppressCount(
            {
                symbol: state.currentSymbol,
                interval: state.currentInterval,
            },
            input
        ));
        await dataManager.loadData(input.symbol, input.interval);
        setBlockRange(cloneBlockRange(input.blockRange));

        if (input.strategyKey && strategyRegistry.has(input.strategyKey)) {
            setCurrentStrategyKey(input.strategyKey);
            const strategy = strategyRegistry.get(input.strategyKey);
            if (strategy && input.strategyParams) {
                paramManager.setValues(strategy, input.strategyParams);
            }
        }
    };

    if (input.temporary) {
        await settingsManager.runWithoutAutoSave(work);
        return;
    }

    await work();
}

function createSelectedStrategies(strategyKeys: readonly string[]): FinderSelectedStrategy[] {
    return strategyKeys
        .map((key) => {
            const strategy = strategyRegistry.get(key);
            if (!strategy) {
                return null;
            }
            return {
                key,
                name: strategy.name,
                strategy,
            };
        })
        .filter((entry): entry is FinderSelectedStrategy => entry !== null);
}

export function createHuntRunController(
    input: {
        profiles: HuntProfile[];
        runSettings: HuntRunSettings;
    },
    callbacks: {
        onProgress?: (progress: HuntRunProgress) => void;
        onMessage?: (message: HuntRunMessage) => void;
    } = {}
): HuntRunController {
    let cancelled = false;

    const emitMessage = (message: HuntRunMessage): void => {
        callbacks.onMessage?.(message);
    };

    const emitProgress = (progress: HuntRunProgress): void => {
        callbacks.onProgress?.(progress);
    };

    return {
        cancel: () => {
            cancelled = true;
        },
        run: async () => {
            const runSettings = cloneHuntRunSettings(input.runSettings);
            const finderOptions = buildHuntFinderOptions(runSettings);
            const primaryMetric = getHuntPrimaryMetric(finderOptions);
            const paramSpace = new FinderParamSpace();
            const originalContext = captureOriginalUiContext();
            const selectedStrategies = createSelectedStrategies(runSettings.selectedStrategyKeys);
            const totalProfiles = input.profiles.length;
            const totalStrategies = selectedStrategies.length;
            const messages: HuntRunMessage[] = [];
            const taggedResults: HuntProfileRunResult[] = [];

            const pushMessage = (message: HuntRunMessage): void => {
                messages.push(message);
                emitMessage(message);
            };

            if (totalProfiles === 0) {
                throw new Error("Select at least one Hunt profile.");
            }
            if (totalStrategies === 0) {
                throw new Error("Select at least one strategy for Hunt.");
            }

            emitProgress({
                percent: 0,
                status: "Preparing Hunt run...",
                currentProfileLabel: "Idle",
                currentStrategyLabel: `0 / ${totalStrategies}`,
                processedProfiles: 0,
                totalProfiles,
                processedStrategies: 0,
                totalStrategies,
            });

            clearBacktestResults("hunt.run.start");

            try {
                for (let profileIndex = 0; profileIndex < input.profiles.length; profileIndex += 1) {
                    if (cancelled) {
                        break;
                    }

                    const profile = input.profiles[profileIndex];
                    const profileLabel = `Profile ${profileIndex + 1}/${totalProfiles}: ${profile.name}`;

                    emitProgress({
                        percent: (profileIndex / totalProfiles) * 100,
                        status: `Loading ${profile.symbol} ${profile.interval}...`,
                        currentProfileLabel: profileLabel,
                        currentStrategyLabel: `0 / ${totalStrategies}`,
                        processedProfiles: profileIndex,
                        totalProfiles,
                        processedStrategies: 0,
                        totalStrategies,
                    });

                    try {
                        await applyUiContext({
                            symbol: profile.symbol,
                            interval: profile.interval,
                            blockRange: profile.blockRange,
                            backtestSettings: profile.backtestSettings,
                            temporary: true,
                        });

                        const ohlcvData = cloneJson(sliceOhlcvByBlock(state.ohlcvData, state.blockRange));
                        if (ohlcvData.length === 0) {
                            pushMessage({
                                level: "warning",
                                text: `${profile.name}: no chart data was available for ${profile.symbol} ${profile.interval}${profile.blockRange ? " inside the saved block range" : ""}.`,
                            });
                            continue;
                        }

                        const capitalSettings = cloneCapitalSettings(profile.capitalSettings);
                        const backtestSettings = resolveBacktestSettingsFromRaw(profile.backtestSettings, {
                            coerceWithoutUiToggles: false,
                        });
                        const requiresTsEngine =
                            backtestService.requiresTypescriptEngine(backtestSettings)
                            || isSmartTradeSizingMode(capitalSettings.sizingMode);

                        const output = await runFinderExecution(
                            {
                                ohlcvData,
                                symbol: profile.symbol,
                                interval: profile.interval,
                                options: finderOptions,
                                settings: backtestSettings,
                                requiresTsEngine,
                                selectedStrategies,
                                capitalSettings,
                                getFinderTimeframesForRun: () => [profile.interval],
                                loadMultiTimeframeDatasets: async () => [],
                                generateParamSets: (defaultParams, options) => paramSpace.generateParamSets(defaultParams, options),
                                buildRandomConfirmationParams: (strategyKeys, options) => paramSpace.buildRandomConfirmationParams(strategyKeys, options),
                            },
                            {
                                setProgress: (percent, text) => {
                                    const globalPercent = ((profileIndex + (percent / 100)) / totalProfiles) * 100;
                                    emitProgress({
                                        percent: globalPercent,
                                        status: text,
                                        currentProfileLabel: profileLabel,
                                        currentStrategyLabel: `0 / ${totalStrategies}`,
                                        processedProfiles: profileIndex,
                                        totalProfiles,
                                        processedStrategies: 0,
                                        totalStrategies,
                                    });
                                },
                                setStatus: (text) => {
                                    emitProgress({
                                        percent: (profileIndex / totalProfiles) * 100,
                                        status: text,
                                        currentProfileLabel: profileLabel,
                                        currentStrategyLabel: `0 / ${totalStrategies}`,
                                        processedProfiles: profileIndex,
                                        totalProfiles,
                                        processedStrategies: 0,
                                        totalStrategies,
                                    });
                                },
                                yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
                                isCancelled: () => cancelled,
                                onResultsUpdate: () => {},
                                onStrategyPlanStart: (info) => {
                                    emitProgress({
                                        percent: (profileIndex / totalProfiles) * 100,
                                        status: `Running ${runSettings.maxRunsPerStrategy} random searches per strategy`,
                                        currentProfileLabel: profileLabel,
                                        currentStrategyLabel: `${info.index} / ${info.total} | ${info.name}`,
                                        processedProfiles: profileIndex,
                                        totalProfiles,
                                        processedStrategies: info.index,
                                        totalStrategies: info.total,
                                    });
                                },
                            }
                        );

                        const profileResults = tagProfileResults(profile, output.results, finderOptions, runSettings.perProfileKeepN);
                        taggedResults.push(...profileResults);

                        pushMessage({
                            level: profileResults.length > 0 ? "info" : "warning",
                            text: profileResults.length > 0
                                ? `${profile.name}: kept ${profileResults.length} candidates.`
                                : `${profile.name}: Finder returned no kept candidates.`,
                        });

                        emitProgress({
                            percent: ((profileIndex + 1) / totalProfiles) * 100,
                            status: cancelled ? "Hunt cancelled." : "Profile complete.",
                            currentProfileLabel: profileLabel,
                            currentStrategyLabel: `${totalStrategies} / ${totalStrategies}`,
                            processedProfiles: profileIndex + 1,
                            totalProfiles,
                            processedStrategies: totalStrategies,
                            totalStrategies,
                        });
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (cancelled) {
                            pushMessage({
                                level: "warning",
                                text: `Hunt cancelled while running ${profile.name}.`,
                            });
                            break;
                        }
                        pushMessage({
                            level: "error",
                            text: `${profile.name}: ${message}`,
                        });
                    }
                }
            } finally {
                emitProgress({
                    percent: 100,
                    status: "Restoring original UI context...",
                    currentProfileLabel: "Restoring...",
                    currentStrategyLabel: "Idle",
                    processedProfiles: 0,
                    totalProfiles,
                    processedStrategies: 0,
                    totalStrategies,
                });

                await applyUiContext({
                    symbol: originalContext.symbol,
                    interval: originalContext.interval,
                    blockRange: originalContext.blockRange,
                    backtestSettings: originalContext.backtestSettings,
                    strategyKey: originalContext.strategyKey,
                    strategyParams: originalContext.strategyParams,
                    temporary: true,
                });

                if (originalContext.backtestResult) {
                    commitBacktestResult(originalContext.backtestResult, originalContext.backtestResultSource, {
                        endpointCopySnapshot: originalContext.endpointSnapshot,
                        endpointCopyCandles: originalContext.endpointCandles,
                    });
                }
            }

            const profileResults = sortHuntProfileResults(taggedResults);
            const survivors = groupHuntSurvivors(profileResults, primaryMetric);

            if (!cancelled && profileResults.length === 0) {
                pushMessage({
                    level: "warning",
                    text: "Hunt completed but no survivor candidates were produced.",
                });
            }

            return {
                runSettings,
                finderOptions,
                primaryMetric,
                profileResults,
                survivors,
                messages,
                cancelled,
            };
        },
    };
}
