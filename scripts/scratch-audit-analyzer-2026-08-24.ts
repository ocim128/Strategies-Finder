import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFreshWindowAnalysis } from "./analyze-fresh-window-research";

const separator = "=".repeat(80);

function identityHash(symbol: string, strategyKey: string, fingerprint: string): string {
    return createHash("sha256").update(JSON.stringify([symbol, strategyKey, fingerprint])).digest("hex");
}

function buildArchive(options: { strategyCount?: number; badHash?: boolean; missingOutcome?: boolean; invalidFold?: boolean } = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), "fresh-window-audit-"));
    const strategyCount = options.strategyCount ?? 3;
    for (let index = 1; index <= 25; index += 1) {
        const holdout = index * 12;
        const rows = Array.from({ length: strategyCount }, (_, strategyIndex) => {
            const strategyKey = `strategy_${strategyIndex}`;
            const candidateFingerprint = `candidate_${index}_${strategyIndex}`;
            const row: Record<string, unknown> = {
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
                forwardOutcomes: options.missingOutcome && index === 25 && strategyIndex === 2
                    ? {}
                    : { "12": { exitReason: index === 1 ? "take_profit" : index === 2 ? "stop_loss" : "end_of_data", barsHeld: 2, netReturnPercent: strategyIndex === 0 ? 1 : 0, entryPrice: 100, exitPrice: 102 } },
            };
            if (options.badHash && index === 1 && strategyIndex === 0) row.identityHash = "bad";
            return row;
        });
        const searchEnd = 9000 + index;
        const oosStart = 10000 + index * 12;
        const status = options.invalidFold && index === 25 ? "INVALID" : "VALID";
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
            `OOS end: ${oosStart + 11}`,
            `Judgment: ${status}`,
            separator,
            JSON.stringify(rows),
            "",
        ].join("\n");
        writeFileSync(path.join(root, `oos-fold-identities-${holdout}-bars.txt`), content, "utf8");
    }
    const symbols = ["PAIR"];
    const strategyKeys = Array.from({ length: strategyCount }, (_, index) => `strategy_${index}`);
    const identity: Record<string, unknown> = {
        identityVersion: 1,
        researchProgram: "fresh-window",
        symbols,
        symbolDigest: createHash("sha256").update(JSON.stringify(symbols)).digest("hex"),
        strategyKeys,
        strategyDigest: createHash("sha256").update(JSON.stringify(strategyKeys)).digest("hex"),
        providerBySymbol: { PAIR: "binance" },
        engine: { effective: "typescript" },
        foldEnd: 50001,
        dataSyncSnapshot: "sync",
        gitCommit: "commit",
    };
    identity.configIdentityDigest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const config = [
        separator,
        "Timestamp: 2026-08-23T00:00:00.000Z",
        "Batch run id: fixture-run",
        "Run configuration: JSON",
        separator,
        JSON.stringify({ runId: "fixture-run", judgmentStatus: "VALID", freshWindowIdentity: identity, backtestSettings: { slippageBps: 10 }, capitalSettings: { commission: 0.1 }, finder: { assetOpportunity: { evalLastBars: 1000, oosIgnoreLastBars: 26, oosHorizons: [12, 18, 24] } } }),
        "",
    ].join("\n");
    writeFileSync(path.join(root, "config.txt"), config, "utf8");
    return root;
}

function inspect(name: string, root: string): void {
    const lines = runFreshWindowAnalysis({ archiveDirectory: root, seed: 42 });
    console.log(JSON.stringify({
        name,
        s0: lines[2],
        verdicts: lines.filter((line) => /^(Time-to-TP|Recurrence|Strategy gate):/.test(line)),
        hasDecisionBudget: lines.some((line) => line.startsWith("Decision budget:")),
    }));
}

const cases: Array<[string, Parameters<typeof buildArchive>[0]]> = [
    ["baseline", {}],
    ["bad tuple hash", { badHash: true }],
    ["one strategy / low coverage", { strategyCount: 1 }],
    ["one missing outcome", { missingOutcome: true }],
    ["invalid latest fold judgment", { invalidFold: true }],
];

const roots: string[] = [];
try {
    for (const [name, options] of cases) {
        const root = buildArchive(options);
        roots.push(root);
        inspect(name, root);
        if (name === "baseline") {
            const first = runFreshWindowAnalysis({ archiveDirectory: root, seed: 42 }).join("\n");
            const second = runFreshWindowAnalysis({ archiveDirectory: root, seed: 42 }).join("\n");
            console.log(JSON.stringify({ name: "same seed deterministic", equal: first === second }));
        }
    }
} finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
}
