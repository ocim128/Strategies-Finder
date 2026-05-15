const COLLAPSED_KEY = 'livePositionsCollapsed';
const ENABLED_KEY = 'livePositionsEnabled';

function getLocalStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function readStorageValue(key: string): string | null {
    try {
        return getLocalStorage()?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function writeStorageValue(key: string, value: string): void {
    try {
        getLocalStorage()?.setItem(key, value);
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
}

export function readLivePositionsCollapsed(): boolean {
    return readStorageValue(COLLAPSED_KEY) === 'true';
}

export function writeLivePositionsCollapsed(collapsed: boolean): void {
    writeStorageValue(COLLAPSED_KEY, String(collapsed));
}

export function readLivePositionsEnabled(): boolean {
    return readStorageValue(ENABLED_KEY) === 'true';
}

export function writeLivePositionsEnabled(enabled: boolean): void {
    writeStorageValue(ENABLED_KEY, String(enabled));
}
