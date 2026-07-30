import type { RankPairsPerformanceDiagnostics } from "../rank-pairs-performance";
import type {
    RankPairsMode,
    RankResult,
    RecentRankResult,
} from "../rank-pairs-service";

export type RankPairsServerResult = RankResult | RecentRankResult;
export type RankPairsJobPhase = "running" | "finalizing" | "done" | "cancelled" | "fatal";

export type RankPairsStreamEvent =
    | {
        type: "start";
        runId: string;
        total: number;
        interval: string;
        mode: RankPairsMode;
        workerConcurrency: number;
    }
    | {
        type: "progress";
        runId: string;
        completed: number;
        total: number;
        percent: number;
        currentSymbol: string;
        status: string;
    }
    | {
        type: "done";
        ok: boolean;
        cancelled: boolean;
        runId: string;
        interval: string;
        mode: RankPairsMode;
        total: number;
        resultCount: number;
        preview: RankPairsServerResult[];
        summary: string;
        diagnostics: RankPairsPerformanceDiagnostics;
        copyAvailable: boolean;
        reciprocalDuplicates: number;
        selfPairs: number;
    }
    | {
        type: "fatal";
        runId: string;
        error: string;
    };

export interface RankPairsRunStatusSnapshot {
    ok: true;
    running: boolean;
    terminal: boolean;
    runId: string;
    startedAt: number;
    finishedAt: number | null;
    phase: RankPairsJobPhase;
    interval: string;
    mode: RankPairsMode;
    total: number;
    completed: number;
    currentSymbol: string | null;
    progressPercent: number;
    statusText: string;
    cancelled: boolean;
    resultCount: number;
    /** Null while running so status polling remains bounded. */
    terminalPreview: RankPairsServerResult[] | null;
    summary: string | null;
    diagnostics: RankPairsPerformanceDiagnostics | null;
    copyAvailable: boolean;
    reciprocalDuplicates: number;
    selfPairs: number;
    error: string | null;
}
