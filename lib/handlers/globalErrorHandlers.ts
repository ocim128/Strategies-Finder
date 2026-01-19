import { debugLogger } from "../debugLogger";

export function setupGlobalErrorHandlers() {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (event) => {
        debugLogger.error('window.error', {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
        });
    });
    window.addEventListener('unhandledrejection', (event) => {
        debugLogger.error('promise.rejection', {
            reason: formatErrorReason(event.reason),
        });
    });
}

function formatErrorReason(reason: unknown): string {
    if (reason instanceof Error) {
        return `${reason.name}: ${reason.message}`;
    }
    return String(reason);
}
