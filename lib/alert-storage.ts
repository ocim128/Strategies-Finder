const WORKER_URL_KEY = 'alert_worker_url';
const WORKER_TOKEN_KEY = 'alert_worker_token';

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

export function readAlertWorkerToken(): string {
    try {
        return getLocalStorage()?.getItem(WORKER_TOKEN_KEY) ?? '';
    } catch {
        return '';
    }
}

export function writeAlertWorkerToken(token: string): string {
    const normalized = token.trim();
    try {
        const storage = getLocalStorage();
        if (!storage) return normalized;
        if (normalized) {
            storage.setItem(WORKER_TOKEN_KEY, normalized);
        } else {
            storage.removeItem(WORKER_TOKEN_KEY);
        }
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
    return normalized;
}
