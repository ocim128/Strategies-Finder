const COLLAPSED_KEY = 'livePositionsCollapsed';
const ENABLED_KEY = 'livePositionsEnabled';

export function readLivePositionsCollapsed(): boolean {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
}

export function writeLivePositionsCollapsed(collapsed: boolean): void {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
}

export function readLivePositionsEnabled(): boolean {
    return localStorage.getItem(ENABLED_KEY) === 'true';
}

export function writeLivePositionsEnabled(enabled: boolean): void {
    localStorage.setItem(ENABLED_KEY, String(enabled));
}
