export interface DeleteBuiltInStrategyLibraryResponse {
    ok: true;
    key: string;
    sourcePath: string;
    sourceRelativePath: string;
    backupPath: string;
    backupRelativePath: string;
    manifestPath: string;
    manifestStrategyCount: number;
}

export interface DeleteBuiltInStrategyBatchItemResponse {
    key: string;
    sourcePath: string;
    sourceRelativePath: string;
    backupPath: string;
    backupRelativePath: string;
}

export interface DeleteBuiltInStrategyBatchResponse {
    ok: true;
    deleted: DeleteBuiltInStrategyBatchItemResponse[];
    manifestPath: string;
    manifestStrategyCount: number;
}

function getErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const value = payload as Record<string, unknown>;
    return typeof value.error === "string" && value.error.trim().length > 0
        ? value.error
        : null;
}

export async function deleteBuiltInStrategyLibraryEntry(
    key: string,
): Promise<DeleteBuiltInStrategyLibraryResponse> {
    let response: Response;

    try {
        response = await fetch("/api/strategy-library/delete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ key }),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to reach /api/strategy-library/delete: ${message}`);
    }

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(getErrorMessage(payload) ?? `Strategy delete failed (${response.status}).`);
    }

    if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
        throw new Error("Strategy delete response was malformed.");
    }

    return payload as DeleteBuiltInStrategyLibraryResponse;
}

export async function deleteBuiltInStrategyLibraryEntries(
    keys: readonly string[],
): Promise<DeleteBuiltInStrategyBatchResponse> {
    let response: Response;

    try {
        response = await fetch("/api/strategy-library/delete-batch", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ keys }),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to reach /api/strategy-library/delete-batch: ${message}`);
    }

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(getErrorMessage(payload) ?? `Strategy batch delete failed (${response.status}).`);
    }

    if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
        throw new Error("Strategy batch delete response was malformed.");
    }

    return payload as DeleteBuiltInStrategyBatchResponse;
}
