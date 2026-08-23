import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runFreshWindowAnalysis } from "../scripts/analyze-fresh-window-research";

const separator = "=".repeat(80);

function identityHash(symbol: string, strategyKey: string, candidateFingerprint: string): string {
    return createHash("sha256")
        .update(JSON.stringify([symbol, strategyKey, candidateFingerprint]))
        .digest("hex");
}

function buildArchive(options?: { strategyCount?: number; badHash?: boolean }): string {
    const root = mkdtempSync(path.join(tmpdir(), "fresh-window-analyzer-"));
    const strategyCount = options?.strategyCount ?? 3;
    for (let index = 1; index <= 25; index += 1) {
        const holdout = index * 12;
        const rows = Array.from({ length: strategyCount }, (_, strategyIndex) => {
            const strategyKey = `strategy_${strategyIndex}`;
            const candidateFingerprint = `candidate_${index}_${strategyIndex}`;
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
                evaluationOk: true,
                passesTradeFilter: true,
                profitFactor: strategyIndex === 0 ? 3 : 1,
                netProfitPercent: 1,
                totalTrades: 3,
                tpHitCount: 3,
                medianBarsToTP: strategyIndex === 0 ? 5 : 2,
                medianBarsToTerminal: 4,
                tpFirstShare: 1,
                forwardOutcomes: {
                    "12": {
                        exitReason,
                        barsHeld: 2,
                        netReturnPercent: strategyIndex === 0 ? 1 : 0,
                        entryPrice: 100,
                        exitPrice: 102,
                    },
                },
            };
            if (options?.badHash && index === 1 && strategyIndex === 0) row.identityHash = "bad";
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
            `Fold end: ${50000 + index}`,
            `Search window end: ${searchEnd}`,
            `OOS start: ${oosStart}`,
            `OOS end: ${oosEnd}`,
            "Judgment: VALID",
            separator,
            JSON.stringify(rows),
            "",
        ].join("\n");
        writeFileSync(path.join(root, `oos-fold-identities-${holdout}-bars.txt`), content, "utf8");
    }
    const identity = {
        identityVersion: 1,
        researchProgram: "fresh-window",
        symbols: ["PAIR"],
        symbolDigest: createHash("sha256").update(JSON.stringify(["PAIR"])).digest("hex"),
        strategyKeys: Array.from({ length: strategyCount }, (_, index) => `strategy_${index}`),
        strategyDigest: createHash("sha256")
            .update(JSON.stringify(Array.from({ length: strategyCount }, (_, index) => `strategy_${index}`)))
            .digest("hex"),
        providerBySymbol: { PAIR: "binance" },
        engine: { effective: "typescript" },
        foldEnd: 50001,
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
            judgmentStatus: "VALID",
            freshWindowIdentity: identity,
            backtestSettings: { slippageBps: 10 },
            capitalSettings: { commission: 0.1 },
            finder: {
                assetOpportunity: {
                    evalLastBars: 1000,
                    oosIgnoreLastBars: 26,
                    oosHorizons: [12, 18, 24],
                },
            },
        }),
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

    it("kills strategy coverage below the fixed ten-percent gate", () => {
        const root = buildArchive({ strategyCount: 1 });
        try {
            const lines = runFreshWindowAnalysis({ archiveDirectory: root });
            expect(lines.some((line) => line.startsWith("Strategy gate: KILL (coverage"))).to.equal(true);
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
});
