import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { BacktestSettings } from "../lib/types/strategies";
import { runStrategyStressTests, type StressReport } from "./sol-survivor-stress-tests";

type DatasetSpec = {
    symbol: string;
    interval: string;
    dataPath: string;
    bars: number;
};

type ComboResult = {
    symbol: string;
    interval: string;
    strategyKey: string;
    reportPath: string;
    report: StressReport;
    passCount: number;
    fails: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity">;
    compositeScore: number;
};

const TARGET_SYMBOLS = ["BTCUSDT", "SOLUSDT"];
const TARGET_INTERVAL = "4h";
const DEFAULT_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_TICK_BY_SYMBOL: Record<string, number> = {
    BTCUSDT: 0.1,
    SOLUSDT: 0.01,
};

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function readDatasetMeta(filePath: string): DatasetSpec {
    const abs = path.resolve(filePath);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
    const symbol = String(raw.symbol ?? "").trim().toUpperCase();
    const interval = String(raw.interval ?? "").trim();
    const bars = Number(raw.bars ?? (Array.isArray(raw.data) ? raw.data.length : 0));
    if (!symbol || !interval || !Number.isFinite(bars) || bars <= 0) {
        throw new Error(`Invalid dataset metadata: ${abs}`);
    }
    return { symbol, interval, dataPath: abs, bars };
}

function evaluateCombo(report: StressReport): {
    passCount: number;
    fails: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity">;
    compositeScore: number;
} {
    const tests: Array<"oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity"> = [
        "oos70_30",
        "walkForward3m1m",
        "feeSlippageSensitivity",
    ];
    const fails = tests.filter((test) => report[test].verdict !== "PASS");
    const passCount = tests.length - fails.length;
    const compositeScore =
        report.oos70_30.blindMedianNetProfitPercent * 0.30 +
        report.walkForward3m1m.combinedOOS.netProfitPercent * 0.30 +
        report.feeSlippageSensitivity.medianNetProfitPercent * 0.40 -
        report.walkForward3m1m.combinedOOS.maxDrawdownPercent * 0.20 -
        report.feeSlippageSensitivity.medianMaxDrawdownPercent * 0.10;
    return { passCount, fails, compositeScore };
}

function latestEvolutionSummaryPath(): string {
    const root = path.resolve("batch-runs");
    if (!fs.existsSync(root)) {
        throw new Error("batch-runs directory does not exist. Run strategy evolution sweep first.");
    }
    const candidates = fs.readdirSync(root)
        .filter((name) => name.startsWith("strategy-evolution-") && name.includes("-btc-sol-15m-4h"))
        .map((name) => {
            const summaryPath = path.join(root, name, "strategy-evolution-summary.json");
            if (!fs.existsSync(summaryPath)) return null;
            return {
                summaryPath,
                mtime: fs.statSync(summaryPath).mtimeMs,
            };
        })
        .filter((v): v is { summaryPath: string; mtime: number } => Boolean(v))
        .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length === 0) {
        throw new Error("No strategy-evolution summary found.");
    }
    return candidates[0].summaryPath;
}

function resolveTopThreeStrategiesFromSummary(summaryPath: string): {
    strategyKeys: string[];
    sourceRunDir: string;
    sourceSummaryPath: string;
} {
    const summaryAbs = path.resolve(summaryPath);
    const sourceRunDir = path.dirname(summaryAbs);
    const summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8")) as Record<string, unknown>;
    const coverage = (summary.coverage as Record<string, unknown> | undefined) ?? {};
    const datasets = Array.isArray(coverage.datasets) ? coverage.datasets as Array<Record<string, unknown>> : [];

    const rows: Array<{ strategyKey: string; passCount: number; compositeScore: number }> = [];
    for (const dataset of datasets) {
        const symbol = String(dataset.symbol ?? "").toUpperCase();
        const interval = String(dataset.interval ?? "");
        if (!TARGET_SYMBOLS.includes(symbol) || interval !== TARGET_INTERVAL) continue;
        const reportDir = path.join(sourceRunDir, "stress-reports", `${symbol}-${safeName(interval)}`);
        if (!fs.existsSync(reportDir)) continue;
        const files = fs.readdirSync(reportDir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
            const report = JSON.parse(fs.readFileSync(path.join(reportDir, file), "utf8")) as StressReport;
            const evalResult = evaluateCombo(report);
            rows.push({
                strategyKey: report.inputs.strategyKey,
                passCount: evalResult.passCount,
                compositeScore: evalResult.compositeScore,
            });
        }
    }

    const byStrategy = new Map<string, { passCount: number; compositeScore: number }>();
    for (const row of rows) {
        const prev = byStrategy.get(row.strategyKey);
        if (!prev) {
            byStrategy.set(row.strategyKey, { passCount: row.passCount, compositeScore: row.compositeScore });
            continue;
        }
        const better =
            row.passCount > prev.passCount ||
            (row.passCount === prev.passCount && row.compositeScore > prev.compositeScore);
        if (better) {
            byStrategy.set(row.strategyKey, { passCount: row.passCount, compositeScore: row.compositeScore });
        }
    }

    const ranked = Array.from(byStrategy.entries())
        .map(([strategyKey, stats]) => ({ strategyKey, ...stats }))
        .sort((a, b) => b.passCount - a.passCount || b.compositeScore - a.compositeScore)
        .slice(0, 3)
        .map((row) => row.strategyKey);

    if (ranked.length < 3) {
        throw new Error(`Expected at least 3 ranked strategies from ${summaryAbs}, found ${ranked.length}.`);
    }

    return {
        strategyKeys: ranked,
        sourceRunDir,
        sourceSummaryPath: summaryAbs,
    };
}

function resolveFocusedDatasets(sourceRunDir: string): DatasetSpec[] {
    const datasets: DatasetSpec[] = [];
    const sourceDatasetsDir = path.resolve(sourceRunDir, "..", "..", "price-data", "robust-lab", "generated");
    for (const symbol of TARGET_SYMBOLS) {
        const preferred = path.resolve(`price-data/robust-lab/generated/strategy-evolution-2026-02-15-btc-sol-15m-4h/${symbol}-4h.json`);
        const source = path.join(sourceDatasetsDir, `${symbol}-4h.json`);
        const fallback = path.resolve(`price-data/robust-lab/${symbol}-4h.json`);
        const candidates = [preferred, source, fallback].filter((p) => fs.existsSync(p));
        if (candidates.length === 0) {
            throw new Error(`4h dataset missing for ${symbol}.`);
        }
        const meta = readDatasetMeta(candidates[0]);
        if (meta.bars < 1000) {
            throw new Error(`Need >=1000 bars for ${symbol} 4h, found ${meta.bars}.`);
        }
        datasets.push(meta);
    }
    return datasets;
}

function runRobustBatch(configPath: string): void {
    const result = spawnSync(
        "npm",
        ["run", "robust:batch", "--", "--config", configPath],
        {
            stdio: "inherit",
            shell: true,
        }
    );
    if ((result.status ?? 1) !== 0) {
        throw new Error(`robust:batch failed with exit code ${result.status}`);
    }
}

async function main(): Promise<void> {
    const force = process.argv.includes("--force");
    const summaryFlagIndex = process.argv.findIndex((arg) => arg === "--source-summary");
    const sourceSummaryPathInput = summaryFlagIndex >= 0 && process.argv[summaryFlagIndex + 1]
        ? process.argv[summaryFlagIndex + 1]
        : latestEvolutionSummaryPath();

    const selected = resolveTopThreeStrategiesFromSummary(sourceSummaryPathInput);
    const strategyKeys = selected.strategyKeys;
    const datasets = resolveFocusedDatasets(selected.sourceRunDir);
    const dateTag = new Date().toISOString().slice(0, 10);
    const runTag = `${dateTag}-btc-sol-4h-focused`;

    const outDir = path.resolve(`batch-runs/surgical-optimization-${runTag}`);
    const stressOutDir = path.join(outDir, "stress-reports");
    const stopSweepDir = path.join(outDir, "dynamic-vix-stop-sweep");
    fs.mkdirSync(stressOutDir, { recursive: true });
    fs.mkdirSync(stopSweepDir, { recursive: true });

    console.log(`[focus] source summary: ${selected.sourceSummaryPath}`);
    console.log(`[focus] selected strategies: ${strategyKeys.join(", ")}`);

    const robustOutDir = path.resolve(`batch-runs/surgical-optimization-robust-${runTag}`);
    fs.mkdirSync(robustOutDir, { recursive: true });
    const robustConfigPath = path.resolve(`scripts/robust-batch-config.surgical-optimization-${runTag}.json`);
    const robustConfig = {
        strategyKeys,
        seeds: DEFAULT_SEEDS,
        finder: {
            rangePercent: 35,
            maxRuns: 120,
            steps: 3,
            topN: 12,
            minTrades: 40,
        },
        tradeFilterModes: ["none"],
        tradeDirections: ["both"],
        backtestSettings: {
            tradeFilterMode: "none",
            tradeDirection: "both",
            executionModel: "next_open",
            allowSameBarExit: false,
            slippageBps: 5,
        },
        capital: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0.1,
            sizingMode: "percent",
            fixedTradeAmount: 1000,
        },
        reportPolicy: {
            minSeedRuns: 5,
            minSeedPasses: 3,
            minMedianCellPassRate: 0.01,
            minMedianStageCSurvivors: 2,
            maxMedianDDBreachRate: 0.2,
            maxMedianFoldStabilityPenalty: 1.8,
        },
        output: {
            outDir: robustOutDir,
            filePrefix: "run-seed",
            writePerCellJsonSummary: true,
            writePerCellJsonReport: true,
            writePerCellTableReport: false,
            writeBatchJsonSummary: true,
            writeBatchJsonReport: true,
            writeBatchTableReport: true,
        },
        matrix: datasets.map((dataset) => ({
            label: `${dataset.symbol.toLowerCase()}-${safeName(dataset.interval)}`,
            enabled: true,
            dataPath: dataset.dataPath,
            symbol: dataset.symbol,
            interval: dataset.interval,
        })),
    };
    fs.writeFileSync(robustConfigPath, JSON.stringify(robustConfig, null, 2), "utf8");
    runRobustBatch(robustConfigPath);

    const comboResults: ComboResult[] = [];
    let completed = 0;
    const total = datasets.length * strategyKeys.length;
    for (const dataset of datasets) {
        const datasetOutDir = path.join(stressOutDir, `${dataset.symbol}-${safeName(dataset.interval)}`);
        fs.mkdirSync(datasetOutDir, { recursive: true });

        for (const strategyKey of strategyKeys) {
            completed++;
            const fileName = `${safeName(strategyKey)}.json`;
            const reportPath = path.join(datasetOutDir, fileName);
            let report: StressReport;
            if (!force && fs.existsSync(reportPath)) {
                report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as StressReport;
            } else {
                const outcome = await runStrategyStressTests({
                    dataPath: dataset.dataPath,
                    strategyKey,
                    tickSize: DEFAULT_TICK_BY_SYMBOL[dataset.symbol] ?? 0.01,
                    seeds: DEFAULT_SEEDS,
                    finderMaxRuns: 120,
                    walkForwardMaxCombinations: 180,
                    outputDir: datasetOutDir,
                    outputFileName: fileName,
                    quiet: true,
                });
                report = outcome.report;
            }
            const evalResult = evaluateCombo(report);
            comboResults.push({
                symbol: dataset.symbol,
                interval: dataset.interval,
                strategyKey,
                reportPath,
                report,
                passCount: evalResult.passCount,
                fails: evalResult.fails,
                compositeScore: evalResult.compositeScore,
            });
            console.log(`[focus] ${completed}/${total} ${dataset.symbol} ${dataset.interval} ${strategyKey} -> ${report.overall.verdict} (${evalResult.passCount}/3)`);
        }
    }

    const stopGrid = [0.7, 0.9, 1.1, 1.3, 1.5, 1.8, 2.2];
    const stopSweepRows: Array<{
        symbol: string;
        stopLossAtr: number;
        verdict: "PASS" | "FAIL";
        passCount: number;
        walkForwardEfficiency: number;
        walkForwardNetProfitPercent: number;
        walkForwardMaxDrawdownPercent: number;
        feeMedianNetProfitPercent: number;
        feeMedianMaxDrawdownPercent: number;
        reportPath: string;
    }> = [];

    const dynamicVixStopBase: Partial<BacktestSettings> = {
        atrPeriod: 14,
        riskMode: "simple",
        takeProfitAtr: 0,
        trailingAtr: 0,
        timeStopBars: 0,
    };

    for (const dataset of datasets) {
        const symbolSweepDir = path.join(stopSweepDir, `${dataset.symbol}-${safeName(dataset.interval)}`);
        fs.mkdirSync(symbolSweepDir, { recursive: true });
        for (const stopLossAtr of stopGrid) {
            const reportFile = `dynamic_vix_regime-stop-${stopLossAtr.toFixed(2)}.json`;
            const reportPath = path.join(symbolSweepDir, reportFile);
            const outcome = await runStrategyStressTests({
                dataPath: dataset.dataPath,
                strategyKey: "dynamic_vix_regime",
                tickSize: DEFAULT_TICK_BY_SYMBOL[dataset.symbol] ?? 0.01,
                seeds: DEFAULT_SEEDS,
                finderMaxRuns: 120,
                walkForwardMaxCombinations: 180,
                backtestSettingsOverrides: {
                    ...dynamicVixStopBase,
                    stopLossAtr,
                },
                outputDir: symbolSweepDir,
                outputFileName: reportFile,
                quiet: true,
            });
            const report = outcome.report;
            const evalResult = evaluateCombo(report);
            stopSweepRows.push({
                symbol: dataset.symbol,
                stopLossAtr,
                verdict: report.overall.verdict,
                passCount: evalResult.passCount,
                walkForwardEfficiency: report.walkForward3m1m.walkForwardEfficiency,
                walkForwardNetProfitPercent: report.walkForward3m1m.combinedOOS.netProfitPercent,
                walkForwardMaxDrawdownPercent: report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
                feeMedianNetProfitPercent: report.feeSlippageSensitivity.medianNetProfitPercent,
                feeMedianMaxDrawdownPercent: report.feeSlippageSensitivity.medianMaxDrawdownPercent,
                reportPath,
            });
            console.log(
                `[stop-sweep] ${dataset.symbol} stopLossAtr=${stopLossAtr.toFixed(2)} -> ${report.walkForward3m1m.verdict}` +
                ` WFE=${report.walkForward3m1m.walkForwardEfficiency.toFixed(3)} WFNet=${report.walkForward3m1m.combinedOOS.netProfitPercent.toFixed(2)}%`
            );
        }
    }

    const stopSweepRanked = stopSweepRows
        .slice()
        .sort((a, b) =>
            b.passCount - a.passCount ||
            b.walkForwardEfficiency - a.walkForwardEfficiency ||
            a.walkForwardMaxDrawdownPercent - b.walkForwardMaxDrawdownPercent ||
            b.walkForwardNetProfitPercent - a.walkForwardNetProfitPercent
        );

    const summary = {
        generatedAt: new Date().toISOString(),
        sourceSummaryPath: selected.sourceSummaryPath,
        focusedScope: {
            symbols: TARGET_SYMBOLS,
            interval: TARGET_INTERVAL,
            selectedStrategies: strategyKeys,
            datasets,
        },
        focusedResults: comboResults.map((row) => ({
            symbol: row.symbol,
            interval: row.interval,
            strategyKey: row.strategyKey,
            passCount: row.passCount,
            fails: row.fails,
            compositeScore: row.compositeScore,
            oos: row.report.oos70_30.verdict,
            wf: row.report.walkForward3m1m.verdict,
            fee: row.report.feeSlippageSensitivity.verdict,
            reportPath: row.reportPath,
        })),
        stopLossSensitivity: {
            strategyKey: "dynamic_vix_regime",
            stopLossAtrGrid: stopGrid,
            rows: stopSweepRows,
            bestBySymbol: TARGET_SYMBOLS.map((symbol) => {
                const rows = stopSweepRanked.filter((row) => row.symbol === symbol);
                return {
                    symbol,
                    best: rows[0] ?? null,
                };
            }),
        },
    };

    const summaryPath = path.join(outDir, "surgical-optimization-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const txt: string[] = [];
    txt.push(`Surgical Optimization - ${new Date().toISOString()}`);
    txt.push(`Source summary: ${selected.sourceSummaryPath}`);
    txt.push(`Focused strategies: ${strategyKeys.join(", ")}`);
    txt.push("");
    txt.push("Focused Results:");
    for (const row of summary.focusedResults) {
        txt.push(
            `  ${row.symbol} ${row.interval} ${row.strategyKey} | pass=${row.passCount}/3 | ` +
            `oos=${row.oos} wf=${row.wf} fee=${row.fee} | score=${row.compositeScore.toFixed(2)}`
        );
    }
    txt.push("");
    txt.push("Dynamic VIX Stop-Loss Sensitivity (best per symbol):");
    for (const best of summary.stopLossSensitivity.bestBySymbol) {
        if (!best.best) {
            txt.push(`  ${best.symbol} | no rows`);
            continue;
        }
        txt.push(
            `  ${best.symbol} | stop=${best.best.stopLossAtr.toFixed(2)} | pass=${best.best.passCount}/3 | ` +
            `WFE=${best.best.walkForwardEfficiency.toFixed(3)} | WF net=${best.best.walkForwardNetProfitPercent.toFixed(2)}% | ` +
            `WF DD=${best.best.walkForwardMaxDrawdownPercent.toFixed(2)}%`
        );
    }
    const txtPath = path.join(outDir, "surgical-optimization-summary.txt");
    fs.writeFileSync(txtPath, `${txt.join("\n")}\n`, "utf8");

    console.log(`[surgical] Wrote summary: ${summaryPath}`);
    console.log(`[surgical] Wrote text summary: ${txtPath}`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`surgical-optimization failed: ${message}`);
    process.exitCode = 1;
});
