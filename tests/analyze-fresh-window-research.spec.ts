import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runFreshWindowAnalysis } from "../scripts/analyze-fresh-window-research";

const separator = "=".repeat(80);
const completeMarker = "Record complete: true";

function identityHash(symbol: string, strategyKey: string, candidateFingerprint: string): string {
    return createHash("sha256")
        .update(JSON.stringify([symbol, strategyKey, candidateFingerprint]))
        .digest("hex");
}

function buildArchive(options?: {
    strategyCount?: number;
    badHash?: boolean;
    missingOutcome?: boolean;
    invalidFold?: boolean;
    recurring?: boolean;
    medianWinnerPositive?: boolean;
    extraIneligibleStrategies?: number;
    partialFold?: boolean;
}): string {
    const root = mkdtempSync(path.join(tmpdir(), "fresh-window-analyzer-"));
    const strategyCount = options?.strategyCount ?? 3;
    const totalStrategyCount = strategyCount + (options?.extraIneligibleStrategies ?? 0);
    for (let index = 1; index <= 25; index += 1) {
        const holdout = index * 12;
        const rows = Array.from({ length: totalStrategyCount }, (_, strategyIndex) => {
            const strategyKey = `strategy_${strategyIndex}`;
            const candidateFingerprint = options?.recurring && strategyIndex === 0
                ? "recurring-candidate"
                : `candidate_${index}_${strategyIndex}`;
            const eligible = strategyIndex < strategyCount;
            const exitReason = index === 1
                ? "take_profit"
                : index === 2
                    ? "stop_loss"
                    : "end_of_data";
            const row = {
                symbol: "PAIR",
                strategyKey,
                candidateFingerprint,
                identityHash: identityHash("PAIR", strategyKey, candidateFingerprint),
                candidateIndex: strategyIndex,
                evaluationOk: eligible,
                passesTradeFilter: eligible,
                profitFactor: options?.recurring
                    ? strategyIndex === 1 ? 3 : 1
                    : strategyIndex === 0 ? 3 : 1,
                netProfitPercent: 1,
                totalTrades: 3,
                tpHitCount: 3,
                medianBarsToTP: options?.recurring
                    ? strategyIndex === 0 ? 2 : 5
                    : strategyIndex === 0 ? 5 : 2,
                medianBarsToTerminal: 4,
                tpFirstShare: 1,
                forwardOutcomes: {
                    "12": {
                        exitReason,
                        barsHeld: 2,
                        grossReturnPercent: strategyIndex === 0 ? 1.2 : 0.2,
                        slippagePercent: 0.1,
                        commissionPercent: 0.1,
                        netReturnPercent: options?.medianWinnerPositive
                            ? strategyIndex === 0 ? 1 : strategyIndex === 1 ? -1 : 0
                            : strategyIndex === 0 ? 1 : 0,
                        entryPrice: 100,
                        exitPrice: 102,
                        entryTimestamp: `2026-08-22T00:${String(index).padStart(2, "0")}:00.000Z`,
                        exitTimestamp: `2026-08-22T01:${String(index).padStart(2, "0")}:00.000Z`,
                    },
                },
            };
            if (options?.badHash && index === 1 && strategyIndex === 0) row.identityHash = "bad";
            if (options?.missingOutcome && index === 25 && strategyIndex === strategyCount - 1) {
                row.forwardOutcomes = {};
            }
            return row;
        });
        const searchEnd = 9000 + index;
        const oosStart = 10000 + index * 12;
        const oosEnd = oosStart + 11;
        const content = [
            separator,
            `Timestamp: 2026-08-23T00:${String(index).padStart(2, "0")}:00.000Z`,
            "Batch run id: fixture-run",
            `Fold id: ${holdout}`,
            `OOS holdout: ${holdout} bars`,
            `Declared row count: ${rows.length}`,
            `Expected evaluated row count: ${rows.length}`,
            `Forward outcome row count: ${rows.filter((row) => row.forwardOutcomes?.["12"] !== undefined).length}`,
            `Fold end: ${9000 + index}`,
            `Search window end: ${searchEnd}`,
            `OOS start: ${oosStart}`,
            `OOS end: ${oosEnd}`,
            `Judgment: ${options?.invalidFold && index === 25 ? "INVALID" : "VALID"}`,
            separator,
            JSON.stringify(rows),
            ...(options?.partialFold && index === 25 ? [] : [completeMarker]),
            "",
        ].join("\n");
        writeFileSync(path.join(root, `oos-fold-identities-${holdout}-bars.txt`), content, "utf8");
    }
    const foldSchedule = Array.from({ length: 25 }, (_, index) => ({
        holdoutBars: (index + 1) * 12,
        foldEnd: 9001 + index,
    }));
    const identity = {
        identityVersion: 1,
        researchProgram: "fresh-window",
        symbols: ["PAIR"],
        symbolDigest: createHash("sha256").update(JSON.stringify(["PAIR"])).digest("hex"),
        strategyKeys: Array.from({ length: totalStrategyCount }, (_, index) => `strategy_${index}`),
        strategyDigest: createHash("sha256")
            .update(JSON.stringify(Array.from({ length: totalStrategyCount }, (_, index) => `strategy_${index}`)))
            .digest("hex"),
        providerBySymbol: { PAIR: "binance" },
        engine: { effective: "typescript" },
        foldSchedule,
        foldScheduleDigest: createHash("sha256").update(JSON.stringify(foldSchedule)).digest("hex"),
        controlSeed: 42,
        dataSyncSnapshot: "sync",
        gitCommit: "commit",
    };
    Object.assign(identity, {
        configIdentityDigest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    });
    const config = [
        separator,
        "Timestamp: 2026-08-23T00:00:00.000Z",
        "Batch run id: fixture-run",
        "Run configuration: JSON",
        separator,
        JSON.stringify({
            runId: "fixture-run",
            interval: "4h",
            judgmentStatus: "VALID",
            freshWindowIdentity: identity,
            backtestSettings: {
                executionModel: "next_open",
                tradeDirection: "long",
                allowSameBarExit: false,
                riskMode: "percentage",
                stopLossEnabled: true,
                stopLossPercent: 2,
                takeProfitEnabled: true,
                takeProfitPercent: 2,
                slippageBps: 10,
            },
            capitalSettings: { commission: 0.1 },
            finder: {
                scope: "asset_opportunity",
                mode: "random",
                assetOpportunity: {
                    evalLastBars: 1000,
                    oosIgnoreLastBars: 26,
                    oosHorizons: [12, 18, 24],
                },
            },
        }),
        completeMarker,
        "",
    ].join("\n");
    writeFileSync(path.join(root, "config.txt"), config, "utf8");
    return root;
}

describe("fresh-window research analyzer", () => {
    it("passes S0 and keeps legacy rows diagnostic-only", () => {
        const root = buildArchive();
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines[2]).to.equal("S0: PASS");
            expect(lines.some((line) => line.startsWith("Legacy visible-pool diagnostic only:"))).to.equal(true);
            expect(lines.some((line) => line.startsWith("Recurrence: INSUFFICIENT DATA"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("kills a both-halves negative time-to-TP result after S0", () => {
        const root = buildArchive();
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Time-to-TP: KILL"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("judges the median-bars selector when PF and median-bars disagree", () => {
        const root = buildArchive({ recurring: true, medianWinnerPositive: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Time-to-TP:") && line.includes("execution-net delta"))).to.equal(true);
            expect(lines.some((line) => line.includes("delta(control-selected bars)"))).to.equal(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses strict prior-fold recurrence counts and its execution-net judge", () => {
        const root = buildArchive({ recurring: true, medianWinnerPositive: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Recurrence:") && !line.includes("INSUFFICIENT DATA"))).to.equal(true);
            expect(lines.some((line) => line.startsWith("Recurrence budget: collection=PASS, judged=PASS"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("kills strategy coverage below the fixed ten-percent gate", () => {
        const root = buildArchive({ strategyCount: 1 });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Strategy gate: KILL (coverage"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("computes strategy coverage from eligible rows and eligible-pair denominator", () => {
        const root = buildArchive({ strategyCount: 1, extraIneligibleStrategies: 2 });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Strategy gate: KILL (coverage 0.00% < 10%)"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an identity hash failure in S0 and prints no verdict section", () => {
        const root = buildArchive({ badHash: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines[2]).to.equal("S0: FAIL");
            expect(lines.some((line) => line.startsWith("Time-to-TP:"))).to.equal(false);
            expect(lines.some((line) => line.includes("tuple hash mismatch"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects missing forward outcomes below the coverage threshold", () => {
        const root = buildArchive({ missingOutcome: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines[2]).to.equal("S0: FAIL");
            expect(lines.some((line) => line.includes("coverage below 95%"))).to.equal(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an invalid per-fold judgment before any verdict", () => {
        const root = buildArchive({ invalidFold: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines[2]).to.equal("S0: FAIL");
            expect(lines.some((line) => line.includes("fold judgment is not VALID"))).to.equal(true);
            expect(lines.some((line) => line.startsWith("Time-to-TP:"))).to.equal(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a trailing partial identity block deterministically", () => {
        const root = buildArchive({ partialFold: true });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines[2]).to.equal("S0: FAIL");
            expect(lines.some((line) => line.includes("expected 25 stride-12 windows, found 24"))).to.equal(true);
            expect(lines.some((line) => line.startsWith("Time-to-TP:"))).to.equal(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
