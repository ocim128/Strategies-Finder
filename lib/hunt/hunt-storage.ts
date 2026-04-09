import { debugLogger } from "../debug-logger";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import {
    cloneHuntProfiles,
    cloneHuntUiState,
    normalizeStoredHuntProfile,
    normalizeStoredHuntUiState,
    type HuntProfile,
    type HuntUiState,
} from "./hunt-model";

const HUNT_PROFILES_STORAGE = {
    key: "playground_hunt_profiles",
    schema: "hunt.profiles",
    version: 1,
} as const;

const HUNT_UI_STATE_STORAGE = {
    key: "playground_hunt_ui_state",
    schema: "hunt.ui-state",
    version: 1,
} as const;

export function sortHuntProfilesNewestFirst(profiles: readonly HuntProfile[]): HuntProfile[] {
    return [...profiles].sort((left, right) => {
        const leftUpdatedAt = Date.parse(left.updatedAt || left.createdAt || "");
        const rightUpdatedAt = Date.parse(right.updatedAt || right.createdAt || "");

        if (Number.isFinite(leftUpdatedAt) && Number.isFinite(rightUpdatedAt) && leftUpdatedAt !== rightUpdatedAt) {
            return rightUpdatedAt - leftUpdatedAt;
        }

        if (left.updatedAt !== right.updatedAt) {
            return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
        }

        return left.name.localeCompare(right.name);
    });
}

export function loadHuntProfiles(): HuntProfile[] {
    return sortHuntProfilesNewestFirst(readPersistedJson<HuntProfile[]>({
        ...HUNT_PROFILES_STORAGE,
        fallback: [],
        migrate: ({ data }) => {
            if (!Array.isArray(data)) {
                return [];
            }
            return data
                .map((profile) => normalizeStoredHuntProfile(profile))
                .filter((profile): profile is HuntProfile => profile !== null);
        },
        onError: (error) => {
            debugLogger.error("hunt.storage.load_profiles_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    }));
}

export function saveHuntProfiles(profiles: readonly HuntProfile[]): boolean {
    return writePersistedJson({
        ...HUNT_PROFILES_STORAGE,
        data: sortHuntProfilesNewestFirst(cloneHuntProfiles(profiles)),
        onError: (error) => {
            debugLogger.error("hunt.storage.save_profiles_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}

export function upsertHuntProfile(profile: HuntProfile): HuntProfile {
    const profiles = loadHuntProfiles();
    const index = profiles.findIndex((entry) => entry.id === profile.id);

    if (index >= 0) {
        profiles[index] = profile;
    } else {
        profiles.push(profile);
    }

    saveHuntProfiles(profiles);
    return profile;
}

export function deleteHuntProfile(profileId: string): boolean {
    const profiles = loadHuntProfiles();
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
    if (nextProfiles.length === profiles.length) {
        return false;
    }
    return saveHuntProfiles(nextProfiles);
}

export function loadHuntUiState(): HuntUiState {
    return readPersistedJson<HuntUiState>({
        ...HUNT_UI_STATE_STORAGE,
        fallback: cloneHuntUiState(normalizeStoredHuntUiState(null)),
        migrate: ({ data }) => normalizeStoredHuntUiState(data),
        onError: (error) => {
            debugLogger.error("hunt.storage.load_ui_state_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}

export function saveHuntUiState(uiState: HuntUiState): boolean {
    return writePersistedJson({
        ...HUNT_UI_STATE_STORAGE,
        data: cloneHuntUiState(uiState),
        onError: (error) => {
            debugLogger.error("hunt.storage.save_ui_state_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}
