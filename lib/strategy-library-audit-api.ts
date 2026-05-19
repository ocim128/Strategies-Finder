import type { StrategyLibraryAuditResponse } from "./strategy-library-audit-plugin";

export type {
    StrategyLibraryAuditFlag,
    StrategyLibraryAuditResponse,
    StrategyLibraryAuditRow,
} from "./strategy-library-audit-plugin";

function getErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const value = payload as Record<string, unknown>;
    return typeof value.error === "string" && value.error.trim().length > 0
        ? value.error
        : null;
}

function isNumberOrNull(value: unknown): value is number | null {
    return value === null || typeof value === "number";
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertAuditResponse(payload: unknown): asserts payload is StrategyLibraryAuditResponse {
    if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
        throw new Error("Strategy library audit response was malformed.");
    }

    const value = payload as Record<string, unknown>;
    if (
        typeof value.generatedAt !== "string"
        || typeof value.currentStrategyFileCount !== "number"
        || typeof value.archivedStrategyFileCount !== "number"
        || typeof value.scannedFileCount !== "number"
        || !Array.isArray(value.helperRows)
        || !isStringArray(value.warnings)
    ) {
        throw new Error("Strategy library audit response was missing required fields.");
    }

    for (const row of value.helperRows) {
        if (!row || typeof row !== "object") {
            throw new Error("Strategy library audit row was malformed.");
        }
        const item = row as Record<string, unknown>;
        if (
            typeof item.helperName !== "string"
            || typeof item.moduleSpecifier !== "string"
            || typeof item.moduleGroup !== "string"
            || typeof item.currentImportCount !== "number"
            || typeof item.archivedImportCount !== "number"
            || typeof item.currentFileCount !== "number"
            || typeof item.archivedFileCount !== "number"
            || !isNumberOrNull(item.currentUsageRate)
            || !isNumberOrNull(item.archivedUsageRate)
            || !isNumberOrNull(item.archiveRatio)
            || !isNumberOrNull(item.archiveLift)
            || typeof item.evidenceLevel !== "string"
            || !isStringArray(item.flags)
            || !isStringArray(item.currentExamples)
            || !isStringArray(item.archivedExamples)
        ) {
            throw new Error("Strategy library audit row was missing required fields.");
        }
    }
}

export async function getStrategyLibraryAudit(): Promise<StrategyLibraryAuditResponse> {
    let response: Response;

    try {
        response = await fetch("/api/strategy-library/audit");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to reach /api/strategy-library/audit: ${message}`);
    }

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(getErrorMessage(payload) ?? `Strategy library audit failed (${response.status}).`);
    }

    assertAuditResponse(payload);
    return payload;
}
