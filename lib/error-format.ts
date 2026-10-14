/**
 * Canonical rendering of an unknown thrown value for logs and messages.
 *
 * Returns `name: message` for Error instances and `String(value)` otherwise.
 * This is the single owner for an expression that was previously duplicated
 * inline across lib.
 */
export function formatError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
