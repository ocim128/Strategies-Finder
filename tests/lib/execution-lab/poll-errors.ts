export function executionLabErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isExecutionLabTransientPollError(error: unknown): boolean {
    const message = executionLabErrorMessage(error).toLowerCase();
    return message.includes("timeout")
        || message.includes("aborted")
        || message.includes("failed to fetch")
        || message.includes("fetch failed");
}
