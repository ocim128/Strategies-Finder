import { debugLogger } from "../debug-logger";
import { formatError } from "../error-format";

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
            reason: formatError(event.reason),
        });
    });
}
