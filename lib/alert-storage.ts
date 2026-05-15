const WORKER_URL_KEY = 'alert_worker_url';

function getLocalStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readAlertWorkerUrl(): string {
    try {
        return getLocalStorage()?.getItem(WORKER_URL_KEY) ?? '';
    } catch {
        return '';
    }
}

export function writeAlertWorkerUrl(url: string): string {
    const normalized = url.replace(/\/+$/, '');
    try {
        getLocalStorage()?.setItem(WORKER_URL_KEY, normalized);
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
    return normalized;
}
