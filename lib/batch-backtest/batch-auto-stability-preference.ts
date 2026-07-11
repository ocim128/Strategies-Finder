import { readPersistedJson, writePersistedJson } from "../persisted-json";

const STORAGE = {
    key: "playground_batch_auto_run_stability",
    schema: "batch_backtest.auto_run_stability",
    version: 1,
} as const;

export function readBatchAutoRunStability(): boolean {
    return readPersistedJson({
        ...STORAGE,
        fallback: false,
        migrate: ({ data }) => typeof data === "boolean" ? data : null,
    });
}

export function writeBatchAutoRunStability(enabled: boolean): boolean {
    return writePersistedJson({
        ...STORAGE,
        data: enabled,
    });
}

export function shouldAutoRunBatchStability(
    enabled: boolean,
    cancelled: boolean,
    hasMineableArtifacts: boolean,
): boolean {
    return enabled && !cancelled && hasMineableArtifacts;
}
