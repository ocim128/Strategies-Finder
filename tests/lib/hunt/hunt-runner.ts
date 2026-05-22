import { ensureStrategyKeysLoaded, strategyRegistry } from "../../strategyRegistry";
import { backtestService } from "../backtest-service";
import { sliceOhlcvByBlock } from "../block-selector";
import { dataManager } from "../data-manager";
import { debugLogger } from "../debug-logger";
import { FinderParamSpace } from "../finder/finder-param-space";
import { runFinderExecution, type FinderSelectedStrategy } from "../finder/finder-runner";
import { resolveBacktestSettingsFromRaw } from "../backtest-settings-resolver";
import { createTaskYielder } from "../task-yield";
import type { OHLCVData } from "../types/index";
import { isSmartTradeSizingMode } from "../types/backtest";
import type { FinderOptions, FinderMetric } from "../types/finder";
import { buildHuntFinderOptions, getHuntPrimaryMetric, groupHuntSurvivors, sortHuntProfileResults, tagProfileResults } from "./hunt-results";
import {
    cloneCapitalSettings,
    cloneHuntRunSettings,
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

export interface HuntProfileTiming {
    profileName: string;
    symbol: string;
    interval: string;
    dataLoadMs: number;
    blockSliceMs: number;
    finderMs: number;
    totalMs: number;
}

export interface HuntTimingSummary {
    totalRunMs: number;
    profileCount: number;
    profiles: HuntProfileTiming[];
}

export interface HuntRunController {
    run: () => Promise<HuntRunOutput>;
    cancel: () => void;
}

function buildDatasetCacheKey(symbol: string, interval: string): string {
    return `${symbol.trim().toUpperCase()}|${interval.trim().toLowerCase()}`;
}

async function createSelectedStrategies(strategyKeys: readonly string[]): Promise<FinderSelectedStrategy[]> {
    await ensureStrategyKeysLoaded(strategyKeys);
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
            const selectedStrategies = await createSelectedStrategies(runSettings.selectedStrategyKeys);
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

            const huntStartTime = performance.now();
            const profileTimings: HuntProfileTiming[] = [];
            const datasetCache = new Map<string, Promise<OHLCVData[]>>();
            const yielder = createTaskYielder();

            const getOrFetchDataset = (symbol: string, interval: string): Promise<OHLCVData[]> => {
                const key = buildDatasetCacheKey(symbol, interval);
                const cached = datasetCache.get(key);
                if (cached) return cached;
                const promise = dataManager.fetchDataDetached(symbol, interval);
                datasetCache.set(key, promise);
                return promise;
            };

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
                    const profileStartTime = performance.now();

                    const dataLoadStart = performance.now();
                    const rawData = await getOrFetchDataset(profile.symbol, profile.interval);
                    const dataLoadMs = performance.now() - dataLoadStart;

                    const blockSliceStart = performance.now();
                    const slicedRaw = sliceOhlcvByBlock(rawData, profile.blockRange);
                    const ohlcvData = slicedRaw === rawData ? rawData.slice() : slicedRaw;
                    const blockSliceMs = performance.now() - blockSliceStart;
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

                    const finderStart = performance.now();

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
                            generateParamSets: (defaultParams, options) => paramSpace.generateParamSets(defaultParams, options),
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
                            yieldControl: () => yielder.yieldControl(),
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

                    const finderMs = performance.now() - finderStart;
                    const profileTotalMs = performance.now() - profileStartTime;
                    profileTimings.push({
                        profileName: profile.name,
                        symbol: profile.symbol,
                        interval: profile.interval,
                        dataLoadMs,
                        blockSliceMs,
                        finderMs,
                        totalMs: profileTotalMs,
                    });

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

            const totalRunMs = performance.now() - huntStartTime;

            const timingSummary: HuntTimingSummary = {
                totalRunMs,
                profileCount: profileTimings.length,
                profiles: profileTimings,
            };
            debugLogger.event("hunt.run.timing", timingSummary);

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
