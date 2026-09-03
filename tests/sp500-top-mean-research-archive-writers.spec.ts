import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    archiveCompletedTopMeanRun,
    type TopMeanArchiveManifest,
} from "../lib/batch-backtest/sp500-top-mean-archive-log";
import type {
    CandidateOutcomeRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type {
    TopMeanCoordinatorRunRequest,
    TopMeanResultSummary,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";

const request = {
    runId: "top_mean_writer_shape_1",
    interval: "1h",
    horizons: [12],
    saveArchiveLog: true,
} as unknown as TopMeanCoordinatorRunRequest;

const manifest = {
    strategy: { key: "test", params: {}, normalizeApplied: true },
    settings: { backtest: {}, capital: {} },
    pairs: {
        pairs: [], executionOrderSha256: "", sortedSetSha256: "",
        source: { kind: "sp500_default", poolVersion: null },
        construction: { algorithm: null, seed: null },
    },
    catalog: { assets: ["AAA", "BBB"], sha256: "", warmup: null, dataCutoff: null },
    costs: { slippageRate: 0, commissionRate: 0, slippageBps: 0, commissionPercent: 0 },
    windowDesignation: "full_history",
    researchContract: { tieVersion: "", blockCount: 10, bootstrapSamples: 10_000, bootstrapSeed: 1 },
} as TopMeanArchiveManifest;

const event = {
    decisionTime: 1_700_000_000,
    entryTime: 1_700_000_001,
    exitTime: 1_700_000_100,
    horizonBars: 12,
    selector: "TOP_MEAN" as const,
    direction: "long" as const,
    asset: "AAA",
    selectedReturn: 0.1,
    controlReturn: 0.02,
    delta: 0.08,
    eligibleCandidates: 2,
};

function makeOutcome(
    eventId: string,
    horizonBars: number,
    direction: "long" | "short",
    asset: string,
    status: CandidateOutcomeRecord["status"],
): CandidateOutcomeRecord {
    const ok = status === "ok";
    return {
        eventId,
        decisionTimeSec: 1_700_000_000,
        horizonBars,
        direction,
        asset,
        inPool: true,
        eligible: true,
        return: ok ? 0.1 : null,
        entryTimeSec: ok ? 1_700_000_001 : null,
        exitTimeSec: ok ? 1_700_000_100 : null,
        status,
    };
}

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "top-mean-writer-shape-"));
    try {
        const eventId = "1h:1700000000";
        const statuses: CandidateOutcomeRecord["status"][] = [
            "ok", "missing_target", "missing_entry", "right_censored", "invalid_price",
        ];
        const outcomes: CandidateOutcomeRecord[] = [];
        for (const horizonBars of [12, 24]) {
            for (const direction of ["long", "short"] as const) {
                for (const asset of ["AAA", "BBB"]) {
                    const status = statuses[outcomes.length % statuses.length]!;
                    outcomes.push(makeOutcome(eventId, horizonBars, direction, asset, status));
                }
            }
        }
        const summary = {
            completed: true,
            archiveComplete: false,
            counts: { pairCount: 0 },
            reportLines: ["unchanged report"],
            openScoreEventDetails: [event],
            poolSnapshots: [],
            candidateOutcomes: outcomes,
        } as unknown as TopMeanResultSummary;
        const outcome = await archiveCompletedTopMeanRun(summary, request, {
            root,
            canonicalAssets: ["AAA", "BBB"],
            manifest,
        });
        assert.equal(outcome.reason, "saved");
        const runDir = join(root, "archive", "batch-open-score", request.runId);
        const eventRow = JSON.parse(readFileSync(join(runDir, "events-full.jsonl"), "utf8")) as Record<string, unknown>;
        assert.equal(eventRow.eventId, eventId);
        assert.equal(eventRow.poolVersion, null);

        const outcomeRows = readFileSync(join(runDir, "candidate-outcomes.jsonl"), "utf8")
            .trim().split(/\r?\n/).map((line) => JSON.parse(line) as CandidateOutcomeRecord);
        assert.equal(outcomeRows.length, 1 * 2 * 2 * 2);
        assert.deepEqual(new Set(outcomeRows.map((row) => row.status)), new Set(statuses));
        assert.equal(outcomeRows.find((row) => row.status === "right_censored")!.return, null);
        assert.equal(outcomeRows.every((row) => row.eventId === eventId), true);
        console.log("PASS: sp500-top-mean-research-archive-writers.spec.ts");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error("FAIL: sp500-top-mean-research-archive-writers.spec.ts", error);
    process.exit(1);
});
