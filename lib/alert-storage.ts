const WORKER_URL_KEY = 'alert_worker_url';
const WORKER_TOKEN_KEY = 'alert_worker_token';

function getLocalStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function getSessionStorage(): Storage | null {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
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
        const session = getSessionStorage();
        const sessionValue = session?.getItem(WORKER_TOKEN_KEY);
        if (sessionValue) return sessionValue;
    } catch {
        // Fall through to one-time legacy localStorage migration if available.
    }

    let legacyValue = '';
    try {
        const local = getLocalStorage();
        legacyValue = local?.getItem(WORKER_TOKEN_KEY) ?? '';
    } catch {
        return '';
    }
    if (!legacyValue) return '';

    try {
        getSessionStorage()?.setItem(WORKER_TOKEN_KEY, legacyValue);
    } catch {
        // Session storage may be unavailable; still stop keeping the token durably.
    }
    try {
        getLocalStorage()?.removeItem(WORKER_TOKEN_KEY);
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
    return legacyValue;
}

export function writeAlertWorkerToken(token: string): string {
    const normalized = token.trim();
    try {
        const session = getSessionStorage();
        if (normalized) {
            session?.setItem(WORKER_TOKEN_KEY, normalized);
        } else {
            session?.removeItem(WORKER_TOKEN_KEY);
        }
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
    try {
        getLocalStorage()?.removeItem(WORKER_TOKEN_KEY);
    } catch {
        // Best-effort cleanup of the legacy durable token.
    }
    return normalized;
}
