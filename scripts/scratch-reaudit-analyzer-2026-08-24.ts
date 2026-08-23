import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFreshWindowAnalysis } from "./analyze-fresh-window-research";
import { buildFinderAssetOpportunityControlTrace } from "../lib/finder/finder-asset-opportunity-control-trace";
import type { FinderAssetOpportunityCandidateSummaryRow } from "../lib/finder/finder-asset-opportunity-research-types";

const separator = "=".repeat(80);
const completeMarker = "Record complete: true";

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identityHash(symbol: string, strategyKey: string, fingerprint: string): string {
    return digest([symbol, strategyKey, fingerprint]);
}

type BuildOptions = {
    recurring?: boolean;
    halfKill?: boolean;
    strategyCount?: number;
    extraIneligibleStrategies?: number;
    invalidFold?: boolean;
    missingOutcome?: boolean;
    expectedMismatch?: boolean;
    partialFold?: boolean;
    driftField?: string;
    reverseFoldOrder?: boolean;
    malformedTimestamp?: boolean;
    outOfOrderTimestamp?: boolean;
    outOfBoundsTimestamp?: boolean;
    reorderRows?: boolean;
    omitTrace?: boolean;
    batchRole?: "collection" | "judged" | "replication";
};

function foldEndFor(index: number, reverse: boolean): number {
    return reverse ? 1_000 - index : 9_000 + index;
}

function buildArchive(options: BuildOptions = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), "fresh-window-reaudit-"));
    const strategyCount = options.strategyCount ?? 3;
    const totalStrategies = strategyCount + (options.extraIneligibleStrategies ?? 0);
    const foldSchedule = Array.from({ length: 25 }, (_, zeroIndex) => ({
        holdoutBars: (zeroIndex + 1) * 12,
        foldEnd: foldEndFor(zeroIndex + 1, options.reverseFoldOrder === true),
    }));
    const orderedByTimestamp = [...foldSchedule].sort((left, right) => left.foldEnd - right.foldEnd);
    const timestampRank = new Map(orderedByTimestamp.map((entry, index) => [entry.holdoutBars, index]));

    for (let index = 1; index <= 25; index += 1) {
        const holdoutBars = index * 12;
        const foldEnd = foldEndFor(index, options.reverseFoldOrder === true);
        const rank = timestampRank.get(holdoutBars)!;
        const oosStart = 10_000 + rank * 20;
        const oosEnd = oosStart + 9;
        const rows = Array.from({ length: totalStrategies }, (_, strategyIndex) => {
            const strategyKey = `strategy_${strategyIndex}`;
            const eligible = strategyIndex < strategyCount;
            const fingerprint = options.recurring && strategyIndex === 0
                ? "recurring-tuple"
                : `candidate-${index}-${strategyIndex}`;
            const selectedNet = options.halfKill && index > 12 ? -1 : 1;
            const entryTimestamp = options.malformedTimestamp
                ? "not-a-timestamp"
                : options.outOfOrderTimestamp && index === 1 && strategyIndex === 0
                    ? String(oosStart + 2)
                    : options.outOfBoundsTimestamp && index === 1 && strategyIndex === 0
                        ? String(oosStart - 1)
                        : String(oosStart + 1);
            const exitTimestamp = options.malformedTimestamp
                ? "also-not-a-timestamp"
                : options.outOfOrderTimestamp && index === 1 && strategyIndex === 0
                    ? String(oosStart + 1)
                    : String(oosStart + 2);
            const row: Record<string, unknown> = {
                symbol: "PAIR",
                strategyKey,
                candidateFingerprint: fingerprint,
                identityHash: identityHash("PAIR", strategyKey, fingerprint),
                candidateIndex: strategyIndex,
                evaluationOk: eligible,
                passesTradeFilter: eligible,
                profitFactor: strategyIndex === 1 ? 9 : 1,
                netProfitPercent: selectedNet,
                totalTrades: 3,
                tpHitCount: strategyIndex === 0 ? 3 : 1,
                medianBarsToTP: strategyIndex === 0 ? 2 : 5,
                medianBarsToTerminal: 4,
                tpFirstShare: 1,
                forwardOutcomes: {
                    "12": {
                        exitReason: index === 1 ? "take_profit" : index === 2 ? "stop_loss" : "end_of_data",
                        barsHeld: 2,
                        grossReturnPercent: selectedNet + 0.2,
                        slippagePercent: 0.1,
                        commissionPercent: 0.1,
                        netReturnPercent: strategyIndex === 0 ? selectedNet : 0,
                        entryPrice: 100,
                        exitPrice: 102,
                        entryTimestamp,
                        exitTimestamp,
                    },
                },
            };
            if (options.missingOutcome && index === 25 && strategyIndex === 0) row.forwardOutcomes = {};
            return row;
        });
        const outcomeRowCount = rows.filter((row) => (row.forwardOutcomes as Record<string, unknown>)["12"] !== undefined).length;
        const controlTrace = buildFinderAssetOpportunityControlTrace(
            rows as unknown as FinderAssetOpportunityCandidateSummaryRow[],
            index - 1,
            12,
            42,
        );
        const archivedRows = options.reorderRows && index === 2 ? [...rows].reverse() : rows;
        const content = [
            separator,
            `Timestamp: 2026-08-23T00:${String(index).padStart(2, "0")}:00.000Z`,
            "Batch run id: one-collection-run",
            `Batch role: ${options.batchRole ?? "collection"}`,
            `Fold id: ${holdoutBars}`,
            `OOS holdout: ${holdoutBars} bars`,
            `Declared row count: ${rows.length}`,
            `Expected evaluated row count: ${options.expectedMismatch && index === 25 ? rows.length + 1 : rows.length}`,
            `Forward outcome row count: ${outcomeRowCount}`,
            ...(options.omitTrace ? [] : [
                `Control seed: ${controlTrace.seed}`,
                `Control draw digest: ${controlTrace.digest}`,
                `Control draw identities: ${JSON.stringify(controlTrace.draws)}`,
            ]),
            `Fold end: ${foldEnd}`,
            `Search window end: ${foldEnd - 1}`,
            `OOS start: ${oosStart}`,
            `OOS end: ${oosEnd}`,
            `Judgment: ${options.invalidFold && index === 25 ? "INVALID" : "VALID"}`,
            separator,
            JSON.stringify(archivedRows),
            ...(options.partialFold && index === 25 ? [] : [completeMarker]),
            "",
        ].join("\n");
        writeFileSync(path.join(root, `oos-fold-identities-${holdoutBars}-bars.txt`), content, "utf8");
    }

    const strategyKeys = Array.from({ length: totalStrategies }, (_, index) => `strategy_${index}`);
    const identity: Record<string, unknown> = {
        identityVersion: 1,
        researchProgram: "fresh-window",
        symbols: ["PAIR"],
        symbolDigest: digest(["PAIR"]),
        strategyKeys,
        strategyDigest: digest(strategyKeys),
        providerBySymbol: { PAIR: "binance" },
        engine: { effective: "typescript" },
        foldSchedule,
        foldScheduleDigest: digest(foldSchedule),
        controlSeed: 42,
        batchRole: options.batchRole ?? "collection",
        dataSyncSnapshot: "sync-reaudit",
        gitCommit: "reaudit-commit",
    };
    identity.configIdentityDigest = digest(identity);
    const backtestSettings: Record<string, unknown> = {
        executionModel: "next_open",
        tradeDirection: "long",
        allowSameBarExit: false,
        riskMode: "percentage",
        stopLossEnabled: true,
        stopLossPercent: 2,
        takeProfitEnabled: true,
        takeProfitPercent: 2,
        slippageBps: 10,
    };
    if (options.driftField === "tradeDirection") backtestSettings.tradeDirection = "short";
    if (options.driftField === "riskMode") backtestSettings.riskMode = "atr";
    if (options.driftField === "takeProfitPercent") backtestSettings.takeProfitPercent = 3;
    if (options.driftField === "allowSameBarExit") backtestSettings.allowSameBarExit = true;
    if (options.driftField === "executionModel") backtestSettings.executionModel = "next_close";
    const config = [
        separator,
        "Timestamp: 2026-08-23T00:00:00.000Z",
        "Batch run id: one-collection-run",
        "Run configuration: JSON",
        separator,
        JSON.stringify({
            runId: "one-collection-run",
            interval: "4h",
            judgmentStatus: "VALID",
            freshWindowIdentity: identity,
            backtestSettings,
            capitalSettings: { commission: 0.1 },
            finder: {
                scope: "asset_opportunity",
                mode: "random",
                assetOpportunity: { evalLastBars: 1000, oosIgnoreLastBars: 26, oosHorizons: [12, 18, 24] },
            },
        }),
        completeMarker,
        "",
    ].join("\n");
    writeFileSync(path.join(root, "config.txt"), config, "utf8");
    return root;
}

function runCase(name: string, options: BuildOptions): void {
    const root = buildArchive(options);
    try {
        const lines = runFreshWindowAnalysis({ archiveDirectory: root, seed: 42 });
        const allText = [
            readFileSync(path.join(root, "config.txt"), "utf8"),
            ...Array.from({ length: 25 }, (_, index) => readFileSync(path.join(root, `oos-fold-identities-${(index + 1) * 12}-bars.txt`), "utf8")),
        ].join("\n");
        console.log(JSON.stringify({
            name,
            s0: lines[2],
            errors: lines.filter((line) => line.startsWith("S0 ERROR:")),
            verdicts: lines.filter((line) => /^(Time-to-TP|Recurrence|Recurrence budget|Strategy gate):/.test(line)),
            promotionLanguage: lines.filter((line) => /promot|deploy/i.test(line)),
            controlTraceArchived: /Control draw digest|Control draw identities/.test(allText),
        }));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

for (const [name, options] of [
    ["median selector + both-half kill", { halfKill: true }],
    ["recurrence high density with one batch", { recurring: true }],
    ["timestamp order differs from holdout order", { recurring: true, reverseFoldOrder: true }],
    ["failed/ineligible rows and coverage", { strategyCount: 1, extraIneligibleStrategies: 4 }],
    ["invalid fold marker", { invalidFold: true }],
    ["missing outcome below coverage", { missingOutcome: true }],
    ["independent expected count mismatch", { expectedMismatch: true }],
    ["partial trailing block", { partialFold: true }],
    ["settings drift direction", { driftField: "tradeDirection" }],
    ["settings drift risk mode", { driftField: "riskMode" }],
    ["settings drift take profit", { driftField: "takeProfitPercent" }],
    ["settings drift same bar", { driftField: "allowSameBarExit" }],
    ["settings drift entry model", { driftField: "executionModel" }],
    ["malformed outcome timestamps", { malformedTimestamp: true }],
    ["out-of-order outcome timestamps", { outOfOrderTimestamp: true }],
    ["out-of-bounds outcome timestamps", { outOfBoundsTimestamp: true }],
    ["producer trace row reorder", { reorderRows: true }],
    ["missing producer trace", { omitTrace: true }],
    ["one-run judged role", { recurring: true, batchRole: "judged" }],
    ["collection-only role", { recurring: true, batchRole: "collection" }],
    ["replication without judged role", { recurring: true, batchRole: "replication" }],
] as Array<[string, BuildOptions]>) {
    runCase(name, options);
}
