const WORKER_URL_KEY = 'alert_worker_url';

export function readAlertWorkerUrl(): string {
    return localStorage.getItem(WORKER_URL_KEY) ?? '';
}

export function writeAlertWorkerUrl(url: string): string {
    const normalized = url.replace(/\/+$/, '');
    localStorage.setItem(WORKER_URL_KEY, normalized);
    return normalized;
}
