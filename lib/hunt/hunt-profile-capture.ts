import type { UiBacktestEndpointSnapshot } from "../backtest-endpoint-copy";
import { backtestService } from "../backtest-service";
import { settingsManager, type StrategyConfig } from "../settings-manager";
import { state } from "../state";
import {
    buildDefaultHuntProfileName,
    createHuntEntityId,
    mergeCapitalSettingsIntoBacktestSettingsData,
    normalizeStoredHuntProfile,
    normalizeStoredHuntUiState,
    type HuntProfile,
    type HuntUiState,
} from "./hunt-model";

export interface ParsedHuntProfilesImport {
    profiles: HuntProfile[];
    uiState: HuntUiState | null;
}

function requireValidProfile(profile: HuntProfile | null, message: string): HuntProfile {
    if (!profile) {
        throw new Error(message);
    }
    return profile;
}

export function captureCurrentUiAsHuntProfile(name?: string): HuntProfile {
    const capitalSettings = backtestService.getCapitalSettings();
    const backtestSettings = mergeCapitalSettingsIntoBacktestSettingsData(
        settingsManager.getBacktestSettings(),
        capitalSettings
    );

    return requireValidProfile(normalizeStoredHuntProfile({
        id: createHuntEntityId("hunt-profile"),
        name: name || buildDefaultHuntProfileName({
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            blockRange: state.blockRange,
            backtestSettings,
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "current_ui",
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        blockRange: state.blockRange,
        backtestSettings,
        capitalSettings,
    }), "Current UI could not be converted into a Hunt profile.");
}

export function createHuntProfileFromSavedConfigAndCurrentChart(
    config: StrategyConfig,
    name?: string
): HuntProfile {
    const capitalSettings = settingsManager.resolveCapitalFromConfig(config);
    const backtestSettings = mergeCapitalSettingsIntoBacktestSettingsData(config.backtestSettings, capitalSettings);

    return requireValidProfile(normalizeStoredHuntProfile({
        id: createHuntEntityId("hunt-profile"),
        name: name || `${config.name} @ ${state.currentSymbol} ${state.currentInterval}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "saved_config_plus_chart",
        symbol: state.currentSymbol,
        interval: state.currentInterval,
        blockRange: state.blockRange,
        backtestSettings,
        capitalSettings,
    }), "Saved config + chart could not be converted into a Hunt profile.");
}

export function createHuntProfileFromEndpointSnapshot(snapshot: UiBacktestEndpointSnapshot | Record<string, unknown>): HuntProfile {
    const source = snapshot as Record<string, unknown>;

    return requireValidProfile(normalizeStoredHuntProfile({
        id: createHuntEntityId("hunt-profile"),
        name: buildDefaultHuntProfileName({
            symbol: String(source.symbol ?? ""),
            interval: String(source.interval ?? ""),
            blockRange: (source.blockRange ?? null) as { from: number; to: number } | null,
            backtestSettings: source.backtestSettings as Record<string, unknown> | undefined,
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "endpoint_snapshot",
        symbol: source.symbol,
        interval: source.interval,
        blockRange: source.blockRange,
        backtestSettings: source.backtestSettings,
        capitalSettings: source.capitalSettings,
    }), "Endpoint snapshot is missing Hunt-required fields.");
}

export function parseHuntProfilesFromImport(raw: unknown): ParsedHuntProfilesImport {
    if (Array.isArray(raw)) {
        const profiles = raw
            .map((entry) => normalizeStoredHuntProfile(entry))
            .filter((entry): entry is HuntProfile => entry !== null);
        if (profiles.length === 0) {
            throw new Error("No valid Hunt profiles were found in the imported array.");
        }
        return { profiles, uiState: null };
    }

    if (!raw || typeof raw !== "object") {
        throw new Error("Expected Hunt export JSON or an endpoint snapshot object.");
    }

    const source = raw as Record<string, unknown>;
    if (Array.isArray(source.profiles)) {
        const profiles = source.profiles
            .map((entry) => normalizeStoredHuntProfile(entry))
            .filter((entry): entry is HuntProfile => entry !== null);
        if (profiles.length === 0) {
            throw new Error("Imported Hunt export did not contain any valid profiles.");
        }
        return {
            profiles,
            uiState: source.uiState ? normalizeStoredHuntUiState(source.uiState) : null,
        };
    }

    if (source.symbol && source.interval && source.backtestSettings) {
        return {
            profiles: [createHuntProfileFromEndpointSnapshot(source)],
            uiState: null,
        };
    }

    throw new Error("JSON must be a Hunt export payload, a Hunt profile array, or an endpoint snapshot.");
}
