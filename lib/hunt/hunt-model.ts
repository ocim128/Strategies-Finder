import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import {
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredBacktestSettings,
    type BacktestSettingsData,
} from "../settings-model";
import type { CapitalSettings } from "../types/backtest";
import type { FinderMetric, FinderResult, PolymarketFinderRankMode } from "../types/finder";
import { SIGNAL_EXIT_SUPPORTED_RANK_MODES, type PolymarketExitMode } from "../polymarket-exit-mode";
import type { StrategyParams } from "../types/strategies";

export type HuntProfileSource = "current_ui" | "endpoint_snapshot" | "saved_config_plus_chart";
export type HuntResultsView = "survivors" | "per_profile";

export interface HuntProfile {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    source: HuntProfileSource;
    symbol: string;
    interval: string;
    blockRange: { from: number; to: number } | null;
    backtestSettings: BacktestSettingsData;
    capitalSettings: CapitalSettings;
    notes?: string;
}

export interface HuntRunSettings {
    mode: "random";
    maxRunsPerStrategy: number;
    rangePercent: number;
    globalTopN: number;
    perProfileKeepN: number;
    selectedStrategyKeys: string[];
    polymarketScoringEnabled: boolean;
    polymarketRankMode: PolymarketFinderRankMode;
    polymarketMinScoredPredictions: number;
    polymarketLockOffset: boolean;
    polymarketAfterTakeProfitOnly: boolean;
    polymarketExitMode: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent: boolean;
    freezeRiskManagement: boolean;
    tradeCountFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
}

export interface HuntUiState {
    runSettings: HuntRunSettings;
    enabledProfileIds: string[];
    selectedProfileId: string | null;
    resultsView: HuntResultsView;
}

export interface HuntProfileRunResult {
    profileId: string;
    profileName: string;
    symbol: string;
    interval: string;
    blockRange: { from: number; to: number } | null;
    result: FinderResult;
    localRank: number;
}

export interface HuntSurvivorGroup {
    groupKey: string;
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    appearances: number;
    profileIds: string[];
    profileNames: string[];
    bestLocalRank: number;
    medianLocalRank: number;
    bestPrimaryMetric: number;
    medianPrimaryMetric: number;
    bestCandidate: HuntProfileRunResult;
    candidates: HuntProfileRunResult[];
}

export interface HuntProfileExportPayload {
    kind: "hunt_profile_export";
    schema: "hunt.profile-export";
    version: number;
    exportedAt: string;
    profiles: HuntProfile[];
    uiState: HuntUiState;
}

const HUNT_EXPORT_VERSION = 1;
const PARAM_ROUNDING_DECIMALS = 8;
const PARAM_INTEGER_EPSILON = 1e-8;

export const HUNT_MAX_TRADES_UNBOUNDED = 1_000_000;

export const DEFAULT_HUNT_RUN_SETTINGS: Readonly<HuntRunSettings> = Object.freeze({
    mode: "random",
    maxRunsPerStrategy: 120,
    rangePercent: 555,
    globalTopN: 20,
    perProfileKeepN: 50,
    selectedStrategyKeys: [],
    polymarketScoringEnabled: false,
    polymarketRankMode: "balanced",
    polymarketMinScoredPredictions: 100,
    polymarketLockOffset: false,
    polymarketAfterTakeProfitOnly: false,
    polymarketExitMode: "resolve_hold" as PolymarketExitMode,
    polymarketSignalExitAllowMultipleTradesPerEvent: false,
    freezeRiskManagement: false,
    tradeCountFilterEnabled: true,
    minTrades: 40,
    maxTrades: HUNT_MAX_TRADES_UNBOUNDED,
});

export const DEFAULT_HUNT_UI_STATE: Readonly<HuntUiState> = Object.freeze({
    runSettings: { ...DEFAULT_HUNT_RUN_SETTINGS },
    enabledProfileIds: [],
    selectedProfileId: null,
    resultsView: "survivors",
});

export function normalizeHuntPolymarketRankMode(
    rankMode: PolymarketFinderRankMode,
    exitMode: PolymarketExitMode
): PolymarketFinderRankMode {
    if (exitMode !== "signal_exit_same_event") {
        return rankMode;
    }
    return SIGNAL_EXIT_SUPPORTED_RANK_MODES.has(rankMode as any) ? rankMode : "expectancy";
}

function toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function readString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}

function normalizeTimestamp(value: unknown, fallbackIso: string): string {
    const text = readString(value);
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallbackIso;
}

function normalizeSymbol(value: unknown): string {
    return readString(value).toUpperCase();
}

function normalizeInterval(value: unknown): string {
    return readString(value).toLowerCase();
}

function normalizeProfileSource(value: unknown): HuntProfileSource {
    return value === "endpoint_snapshot" || value === "saved_config_plus_chart"
        ? value
        : "current_ui";
}

function normalizeResultsView(value: unknown): HuntResultsView {
    return value === "per_profile" ? "per_profile" : "survivors";
}

function normalizeBlockRange(value: unknown): { from: number; to: number } | null {
    const source = toRecord(value);
    if (!source) {
        return null;
    }

    const from = readNumber(source.from, Number.NaN);
    const to = readNumber(source.to, Number.NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return null;
    }

    return {
        from: Math.min(from, to),
        to: Math.max(from, to),
    };
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const unique = new Set<string>();
    for (const entry of value) {
        const normalized = readString(entry);
        if (normalized) {
            unique.add(normalized);
        }
    }
    return [...unique];
}

function cloneAdvancedSizing(advancedSizing: CapitalSettings["advancedSizing"]): CapitalSettings["advancedSizing"] {
    return advancedSizing ? { ...advancedSizing } : undefined;
}

export function createHuntEntityId(prefix = "hunt"): string {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${random}`;
}

export function cloneBlockRange(blockRange: { from: number; to: number } | null): { from: number; to: number } | null {
    return blockRange ? { ...blockRange } : null;
}

export function cloneCapitalSettings(capitalSettings: CapitalSettings): CapitalSettings {
    return {
        ...capitalSettings,
        advancedSizing: cloneAdvancedSizing(capitalSettings.advancedSizing),
    };
}

export function cloneHuntRunSettings(settings: HuntRunSettings): HuntRunSettings {
    return {
        ...settings,
        selectedStrategyKeys: [...settings.selectedStrategyKeys],
    };
}

export function cloneHuntUiState(uiState: HuntUiState): HuntUiState {
    return {
        runSettings: cloneHuntRunSettings(uiState.runSettings),
        enabledProfileIds: [...uiState.enabledProfileIds],
        selectedProfileId: uiState.selectedProfileId,
        resultsView: uiState.resultsView,
    };
}

export function cloneHuntProfile(profile: HuntProfile): HuntProfile {
    return {
        ...profile,
        blockRange: cloneBlockRange(profile.blockRange),
        backtestSettings: { ...profile.backtestSettings },
        capitalSettings: cloneCapitalSettings(profile.capitalSettings),
    };
}

export function cloneHuntProfiles(profiles: readonly HuntProfile[]): HuntProfile[] {
    return profiles.map((profile) => cloneHuntProfile(profile));
}

export function getMarketSelectionAutoReloadSuppressCount(
    current: { symbol: string; interval: string },
    next: { symbol: string; interval: string }
): number {
    let count = 0;
    if (normalizeSymbol(current.symbol) !== normalizeSymbol(next.symbol)) {
        count += 1;
    }
    if (normalizeInterval(current.interval) !== normalizeInterval(next.interval)) {
        count += 1;
    }
    return count;
}

export function mergeCapitalSettingsIntoBacktestSettingsData(
    backtestSettings: unknown,
    capitalSettings: CapitalSettings
): BacktestSettingsData {
    const merged = normalizeStoredBacktestSettings(backtestSettings);
    merged.initialCapital = capitalSettings.initialCapital;
    merged.positionSize = capitalSettings.positionSize;
    merged.commission = capitalSettings.commission;
    merged.sizingMode = capitalSettings.sizingMode;
    merged.fixedTradeToggle = capitalSettings.sizingMode === "fixed";
    merged.fixedTradeAmount = capitalSettings.fixedTradeAmount;

    if (capitalSettings.advancedSizing) {
        Object.assign(merged, capitalSettings.advancedSizing);
    }

    return merged;
}

export function normalizeStoredHuntRunSettings(raw: unknown): HuntRunSettings {
    const source = toRecord(raw);
    if (!source) {
        return cloneHuntRunSettings(DEFAULT_HUNT_RUN_SETTINGS);
    }

    const tradeCountFilterEnabled = readBoolean(
        source.tradeCountFilterEnabled,
        DEFAULT_HUNT_RUN_SETTINGS.tradeCountFilterEnabled
    );
    const minTrades = tradeCountFilterEnabled
        ? Math.max(0, Math.round(readNumber(source.minTrades, DEFAULT_HUNT_RUN_SETTINGS.minTrades)))
        : 0;
    const rawMaxTrades = tradeCountFilterEnabled
        ? Math.round(readNumber(source.maxTrades, DEFAULT_HUNT_RUN_SETTINGS.maxTrades))
        : HUNT_MAX_TRADES_UNBOUNDED;
    const maxTrades = !tradeCountFilterEnabled || rawMaxTrades <= 0 || !Number.isFinite(rawMaxTrades)
        ? HUNT_MAX_TRADES_UNBOUNDED
        : Math.max(minTrades, rawMaxTrades);

    const polymarketRankMode = source.polymarketRankMode;
    const normalizedRankMode: PolymarketFinderRankMode =
        polymarketRankMode === "accuracy"
        || polymarketRankMode === "accuracyTrades"
        || polymarketRankMode === "expectancy"
        || polymarketRankMode === "expectancyTrades"
        || polymarketRankMode === "profitFactor"
        || polymarketRankMode === "profitFactorTrades"
        || polymarketRankMode === "sizedNet"
        || polymarketRankMode === "volume"
            ? polymarketRankMode
            : DEFAULT_HUNT_RUN_SETTINGS.polymarketRankMode;

    const polymarketExitMode: PolymarketExitMode = typeof source.polymarketExitMode === "string"
        && source.polymarketExitMode.trim().toLowerCase() === "signal_exit_same_event"
        ? "signal_exit_same_event"
        : "resolve_hold";

    return {
        mode: "random",
        maxRunsPerStrategy: Math.max(
            1,
            Math.round(readNumber(source.maxRunsPerStrategy, DEFAULT_HUNT_RUN_SETTINGS.maxRunsPerStrategy))
        ),
        rangePercent: Math.max(0, readNumber(source.rangePercent, DEFAULT_HUNT_RUN_SETTINGS.rangePercent)),
        globalTopN: Math.max(1, Math.round(readNumber(source.globalTopN, DEFAULT_HUNT_RUN_SETTINGS.globalTopN))),
        perProfileKeepN: Math.max(1, Math.round(readNumber(source.perProfileKeepN, DEFAULT_HUNT_RUN_SETTINGS.perProfileKeepN))),
        selectedStrategyKeys: normalizeStringArray(source.selectedStrategyKeys),
        polymarketScoringEnabled: readBoolean(
            source.polymarketScoringEnabled,
            DEFAULT_HUNT_RUN_SETTINGS.polymarketScoringEnabled
        ),
        polymarketMinScoredPredictions: Math.max(
            0,
            Math.round(readNumber(source.polymarketMinScoredPredictions, DEFAULT_HUNT_RUN_SETTINGS.polymarketMinScoredPredictions))
        ),
        polymarketLockOffset: readBoolean(
            source.polymarketLockOffset,
            DEFAULT_HUNT_RUN_SETTINGS.polymarketLockOffset
        ),
        polymarketAfterTakeProfitOnly: readBoolean(
            source.polymarketAfterTakeProfitOnly,
            DEFAULT_HUNT_RUN_SETTINGS.polymarketAfterTakeProfitOnly
        ),
        polymarketExitMode,
        polymarketSignalExitAllowMultipleTradesPerEvent: readBoolean(
            source.polymarketSignalExitAllowMultipleTradesPerEvent,
            DEFAULT_HUNT_RUN_SETTINGS.polymarketSignalExitAllowMultipleTradesPerEvent
        ),
        polymarketRankMode: normalizeHuntPolymarketRankMode(normalizedRankMode, polymarketExitMode),
        freezeRiskManagement: readBoolean(
            source.freezeRiskManagement,
            DEFAULT_HUNT_RUN_SETTINGS.freezeRiskManagement
        ),
        tradeCountFilterEnabled,
        minTrades,
        maxTrades,
    };
}

export function normalizeStoredHuntUiState(raw: unknown): HuntUiState {
    const source = toRecord(raw);
    if (!source) {
        return cloneHuntUiState(DEFAULT_HUNT_UI_STATE);
    }

    return {
        runSettings: normalizeStoredHuntRunSettings(source.runSettings),
        enabledProfileIds: normalizeStringArray(source.enabledProfileIds),
        selectedProfileId: readString(source.selectedProfileId) || null,
        resultsView: normalizeResultsView(source.resultsView),
    };
}

export function buildDefaultHuntProfileName(input: {
    symbol: string;
    interval: string;
    blockRange?: { from: number; to: number } | null;
    backtestSettings?: Partial<BacktestSettingsData> | null;
}): string {
    const parts = [input.symbol, input.interval];
    if (input.blockRange) {
        parts.push("block");
    }
    if (readString(input.backtestSettings?.polymarketOutcomeSymbol)) {
        parts.push("poly");
    }
    return parts.join(" ").trim();
}

export function normalizeStoredHuntProfile(raw: unknown): HuntProfile | null {
    const source = toRecord(raw);
    if (!source) {
        return null;
    }

    const symbol = normalizeSymbol(source.symbol);
    const interval = normalizeInterval(source.interval);
    if (!symbol || !interval) {
        return null;
    }

    const nowIso = new Date().toISOString();
    const capitalSettings = resolveCapitalSettingsFromRaw({
        ...DEFAULT_BACKTEST_SETTINGS,
        ...(toRecord(source.backtestSettings) ?? {}),
        ...(toRecord(source.capitalSettings) ?? {}),
    });
    const backtestSettings = mergeCapitalSettingsIntoBacktestSettingsData(source.backtestSettings, capitalSettings);
    const blockRange = normalizeBlockRange(source.blockRange);

    const name = readString(source.name) || buildDefaultHuntProfileName({
        symbol,
        interval,
        blockRange,
        backtestSettings,
    });
    const notes = readString(source.notes);

    return {
        id: readString(source.id) || createHuntEntityId("hunt-profile"),
        name,
        createdAt: normalizeTimestamp(source.createdAt, nowIso),
        updatedAt: normalizeTimestamp(source.updatedAt, nowIso),
        source: normalizeProfileSource(source.source),
        symbol,
        interval,
        blockRange,
        backtestSettings,
        capitalSettings,
        notes: notes || undefined,
    };
}

export function createHuntProfileExportPayload(
    profiles: readonly HuntProfile[],
    uiState: HuntUiState
): HuntProfileExportPayload {
    return {
        kind: "hunt_profile_export",
        schema: "hunt.profile-export",
        version: HUNT_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        profiles: cloneHuntProfiles(profiles),
        uiState: cloneHuntUiState(uiState),
    };
}

function roundStableNumber(value: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }
    if (Math.abs(value) < PARAM_INTEGER_EPSILON) {
        return 0;
    }
    const roundedInteger = Math.round(value);
    if (Math.abs(value - roundedInteger) <= PARAM_INTEGER_EPSILON) {
        return roundedInteger;
    }

    const scale = 10 ** PARAM_ROUNDING_DECIMALS;
    return Math.round(value * scale) / scale;
}

export function stableNormalizeParams(params: StrategyParams): StrategyParams {
    const normalized: StrategyParams = {};
    const keys = Object.keys(params).sort((left, right) => left.localeCompare(right));

    for (const key of keys) {
        const value = params[key];
        if (typeof value !== "number" || !Number.isFinite(value)) {
            continue;
        }
        normalized[key] = roundStableNumber(value);
    }

    return normalized;
}

export function buildStableParamKey(params: StrategyParams): string {
    return JSON.stringify(stableNormalizeParams(params));
}

export function isBetterMetricValue(
    metric: FinderMetric,
    candidateValue: number,
    currentValue: number | null | undefined
): boolean {
    if (currentValue === null || currentValue === undefined || !Number.isFinite(currentValue)) {
        return true;
    }
    if (!Number.isFinite(candidateValue)) {
        return false;
    }
    if (metric === "maxDrawdownPercent") {
        return candidateValue < currentValue;
    }
    return candidateValue > currentValue;
}

export function createTaggedProfileRunResult(
    profile: HuntProfile,
    result: FinderResult,
    localRank: number
): HuntProfileRunResult {
    return {
        profileId: profile.id,
        profileName: profile.name,
        symbol: profile.symbol,
        interval: profile.interval,
        blockRange: cloneBlockRange(profile.blockRange),
        result,
        localRank,
    };
}
