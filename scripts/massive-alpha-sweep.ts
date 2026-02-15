import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { strategies } from "../lib/strategies/library";
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
    robustPrecheck: {
        verdict: "GO" | "NO_GO" | "UNKNOWN";
        seedPassRate: number | null;
        medianCellPassRate: number | null;
        medianStageCSurvivors: number | null;
    };
};

type NearMissRetest = {
    symbol: string;
    fromInterval: string;
    toInterval: string;
    strategyKey: string;
    verdict: "PASS" | "FAIL";
    passCount: number;
    reportPath: string;
};

type NearMissInfo = {
    symbol: string;
    interval: string;
    strategyKey: string;
    passCount: number;
    failedTest: "oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity";
    barelyMissed: boolean;
    failReasons: string[];
    keyMetrics: Record<string, number>;
    reportPath: string;
    retests: NearMissRetest[];
};

const DEFAULT_DATASETS = [
    "./price-data/robust-lab/BTCUSDT-2h.json",
    "./price-data/robust-lab/ETHUSDT-2h.json",
    "./price-data/robust-lab/BNBUSDT-120m.json",
    "./price-data/robust-lab/SOLUSDT-1h.json",
];

const DEFAULT_SEEDS = [1337, 7331, 2026, 4242, 9001];
const DEFAULT_TICK_BY_SYMBOL: Record<string, number> = {
    BTCUSDT: 0.1,
    ETHUSDT: 0.01,
    BNBUSDT: 0.01,
    SOLUSDT: 0.01,
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
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

function loadRobustReport(reportPath: string): Map<string, {
    verdict: "GO" | "NO_GO";
    seedPassRate: number | null;
    medianCellPassRate: number | null;
    medianStageCSurvivors: number | null;
}> {
    const map = new Map<string, {
        verdict: "GO" | "NO_GO";
        seedPassRate: number | null;
        medianCellPassRate: number | null;
        medianStageCSurvivors: number | null;
    }>();

    if (!fs.existsSync(reportPath)) return map;

    const raw = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const cells = Array.isArray(raw?.report?.cells) ? raw.report.cells : [];
    for (const cell of cells) {
        if (!isObject(cell)) continue;
        const symbol = String(cell.symbol ?? "").trim().toUpperCase();
        const interval = String(cell.timeframe ?? "").trim();
        const strategyKey = String(cell.strategyKey ?? "").trim();
        const verdict = String(cell.verdict ?? "NO_GO").toUpperCase() === "GO" ? "GO" : "NO_GO";
        if (!symbol || !interval || !strategyKey) continue;
        map.set(`${symbol}|${interval}|${strategyKey}`, {
            verdict,
            seedPassRate: Number.isFinite(Number(cell.seedPassRate)) ? Number(cell.seedPassRate) : null,
            medianCellPassRate: Number.isFinite(Number(cell.medianCellPassRate)) ? Number(cell.medianCellPassRate) : null,
            medianStageCSurvivors: Number.isFinite(Number(cell.medianStageCSurvivors)) ? Number(cell.medianStageCSurvivors) : null,
        });
    }
    return map;
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

function nearMissDescriptor(report: StressReport, failedTest: "oos70_30" | "walkForward3m1m" | "feeSlippageSensitivity"): {
    barelyMissed: boolean;
    failReasons: string[];
    keyMetrics: Record<string, number>;
} {
    if (failedTest === "oos70_30") {
        const failReasons = report.oos70_30.failReasons.slice();
        const keyMetrics = {
            trainSeedPassCount: report.oos70_30.trainSeedPassCount,
            blindPositiveSeedCount: report.oos70_30.blindPositiveSeedCount,
            blindMedianNetProfitPercent: report.oos70_30.blindMedianNetProfitPercent,
        };
        const barelyMissed =
            report.oos70_30.trainSeedPassCount >= 2 ||
            report.oos70_30.blindPositiveSeedCount >= 2 ||
            report.oos70_30.blindMedianNetProfitPercent > -1;
        return { barelyMissed, failReasons, keyMetrics };
    }

    if (failedTest === "walkForward3m1m") {
        const failReasons = report.walkForward3m1m.failReasons.slice();
        const keyMetrics = {
            oosNetProfitPercent: report.walkForward3m1m.combinedOOS.netProfitPercent,
            oosDrawdownPercent: report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
            walkForwardEfficiency: report.walkForward3m1m.walkForwardEfficiency,
            parameterStability: report.walkForward3m1m.parameterStability,
        };
        const barelyMissed =
            (failReasons.includes("low_walk_forward_efficiency") ? report.walkForward3m1m.walkForwardEfficiency >= 0.35 : true) &&
            (failReasons.includes("high_combined_oos_drawdown") ? report.walkForward3m1m.combinedOOS.maxDrawdownPercent <= 35 : true) &&
            (failReasons.includes("non_positive_combined_oos_profit") ? report.walkForward3m1m.combinedOOS.netProfitPercent > -2 : true) &&
            (failReasons.includes("low_parameter_stability") ? report.walkForward3m1m.parameterStability >= 35 : true);
        return { barelyMissed, failReasons, keyMetrics };
    }

    const failReasons = report.feeSlippageSensitivity.failReasons.slice();
    const keyMetrics = {
        seedPassCount: report.feeSlippageSensitivity.seedPassCount,
        medianNetProfitPercent: report.feeSlippageSensitivity.medianNetProfitPercent,
        medianMaxDrawdownPercent: report.feeSlippageSensitivity.medianMaxDrawdownPercent,
    };
    const barelyMissed =
        (failReasons.includes("insufficient_seed_passes") ? report.feeSlippageSensitivity.seedPassCount >= 2 : true) &&
        (failReasons.includes("non_positive_median_net_profit") ? report.feeSlippageSensitivity.medianNetProfitPercent > -1 : true) &&
        (failReasons.includes("high_median_drawdown") ? report.feeSlippageSensitivity.medianMaxDrawdownPercent <= 35 : true);
    return { barelyMissed, failReasons, keyMetrics };
}

function ensureDatasetFromSqlite(symbol: string, interval: string, outDir: string): string | null {
    const safeInterval = safeName(interval);
    const filePath = path.resolve(outDir, `${symbol}-${safeInterval}.json`);
    if (fs.existsSync(filePath)) return filePath;

    const dbPath = path.resolve("price-data/market-data.sqlite");
    if (!fs.existsSync(dbPath)) return null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare(
            `SELECT time, open, high, low, close, volume
             FROM candles
             WHERE symbol = ? AND interval = ?
             ORDER BY time ASC`
        ).all(symbol, interval) as Array<Record<string, unknown>>;

        if (!rows || rows.length < 1000) return null;

        const payload = {
            symbol,
            interval,
            provider: "SQLiteLocal",
            bars: rows.length,
            range: {
                start: new Date(Number(rows[0].time) * 1000).toISOString(),
                end: new Date(Number(rows[rows.length - 1].time) * 1000).toISOString(),
            },
            generatedAt: new Date().toISOString(),
            data: rows.map((row) => ({
                time: Number(row.time),
                datetime: new Date(Number(row.time) * 1000).toISOString(),
                open: Number(row.open),
                high: Number(row.high),
                low: Number(row.low),
                close: Number(row.close),
                volume: Number(row.volume),
            })),
        };

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
        return filePath;
    } finally {
        db.close();
    }
}

async function main(): Promise<void> {
    const force = process.argv.includes("--force");
    const dateTag = new Date().toISOString().slice(0, 10);

    const sweepOutDir = path.resolve(`batch-runs/massive-alpha-sweep-${dateTag}`);
    const stressOutDir = path.join(sweepOutDir, "stress-reports");
    fs.mkdirSync(stressOutDir, { recursive: true });

    const datasets = DEFAULT_DATASETS.map((filePath) => readDatasetMeta(filePath));
    const strategyKeys = Object.keys(strategies).sort();

    console.log(`[sweep] Datasets=${datasets.length} Strategies=${strategyKeys.length} TotalCombos=${datasets.length * strategyKeys.length}`);

    const robustOutDir = path.resolve(`batch-runs/massive-alpha-robust-${dateTag}`);
    fs.mkdirSync(robustOutDir, { recursive: true });
    const robustConfigPath = path.resolve(`scripts/robust-batch-config.massive-alpha-${dateTag}.json`);
    const robustConfig = {
        strategyKeys: "all",
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

    console.log(`[sweep] Running robust batch precheck -> ${robustConfigPath}`);
    runRobustBatch(robustConfigPath);
    const robustReportPath = path.join(robustOutDir, `batch-go-no-go-${dateTag}.json`);
    const robustMap = loadRobustReport(robustReportPath);

    const results: ComboResult[] = [];
    let completed = 0;
    const total = datasets.length * strategyKeys.length;

    for (const dataset of datasets) {
        const datasetOutDir = path.join(stressOutDir, `${dataset.symbol}-${safeName(dataset.interval)}`);
        fs.mkdirSync(datasetOutDir, { recursive: true });

        for (const strategyKey of strategyKeys) {
            completed += 1;
            const fileName = `${safeName(strategyKey)}.json`;
            const reportPath = path.join(datasetOutDir, fileName);

            let report: StressReport;
            if (!force && fs.existsSync(reportPath)) {
                report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as StressReport;
            } else {
                const tickSize = DEFAULT_TICK_BY_SYMBOL[dataset.symbol] ?? 0.01;
                const outcome = await runStrategyStressTests({
                    dataPath: dataset.dataPath,
                    strategyKey,
                    tickSize,
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
            const robustKey = `${dataset.symbol}|${dataset.interval}|${strategyKey}`;
            const robustInfo = robustMap.get(robustKey) ?? {
                verdict: "UNKNOWN" as const,
                seedPassRate: null,
                medianCellPassRate: null,
                medianStageCSurvivors: null,
            };

            results.push({
                symbol: dataset.symbol,
                interval: dataset.interval,
                strategyKey,
                reportPath,
                report,
                passCount: evalResult.passCount,
                fails: evalResult.fails,
                compositeScore: evalResult.compositeScore,
                robustPrecheck: robustInfo,
            });

            console.log(`[sweep] ${completed}/${total} ${dataset.symbol} ${dataset.interval} ${strategyKey} -> ${report.overall.verdict} (${evalResult.passCount}/3)`);
        }
    }

    const survivors = results
        .filter((result) => result.passCount === 3)
        .sort((a, b) => b.compositeScore - a.compositeScore);

    const nearMissesRaw = results
        .filter((result) => result.passCount === 2)
        .map((result) => {
            const failedTest = result.fails[0];
            const descriptor = nearMissDescriptor(result.report, failedTest);
            return {
                symbol: result.symbol,
                interval: result.interval,
                strategyKey: result.strategyKey,
                passCount: result.passCount,
                failedTest,
                barelyMissed: descriptor.barelyMissed,
                failReasons: descriptor.failReasons,
                keyMetrics: descriptor.keyMetrics,
                reportPath: result.reportPath,
                retests: [] as NearMissRetest[],
            };
        })
        .sort((a, b) => Number(b.barelyMissed) - Number(a.barelyMissed));

    const nearMisses: NearMissInfo[] = nearMissesRaw;
    const nearMissesForRetest = nearMisses.filter((entry) => entry.barelyMissed);
    const altDatasetDir = path.resolve("price-data/robust-lab/generated");
    fs.mkdirSync(altDatasetDir, { recursive: true });
    const retestIntervals = ["4h", "15m"];

    for (const nearMiss of nearMissesForRetest) {
        for (const altInterval of retestIntervals) {
            if (altInterval === nearMiss.interval) continue;
            const altPath = ensureDatasetFromSqlite(nearMiss.symbol, altInterval, altDatasetDir);
            if (!altPath) continue;

            const retestDir = path.join(sweepOutDir, "near-miss-retests", `${nearMiss.symbol}-${safeName(altInterval)}`);
            fs.mkdirSync(retestDir, { recursive: true });
            const retestFileName = `${safeName(nearMiss.strategyKey)}.json`;
            const retestPath = path.join(retestDir, retestFileName);

            const outcome = await runStrategyStressTests({
                dataPath: altPath,
                strategyKey: nearMiss.strategyKey,
                tickSize: DEFAULT_TICK_BY_SYMBOL[nearMiss.symbol] ?? 0.01,
                seeds: DEFAULT_SEEDS,
                finderMaxRuns: 120,
                walkForwardMaxCombinations: 180,
                outputDir: retestDir,
                outputFileName: retestFileName,
                quiet: true,
            });
            const retestEval = evaluateCombo(outcome.report);
            nearMiss.retests.push({
                symbol: nearMiss.symbol,
                fromInterval: nearMiss.interval,
                toInterval: altInterval,
                strategyKey: nearMiss.strategyKey,
                verdict: outcome.report.overall.verdict,
                passCount: retestEval.passCount,
                reportPath: retestPath,
            });

            console.log(`[retest] ${nearMiss.symbol} ${nearMiss.strategyKey} ${nearMiss.interval} -> ${altInterval} => ${outcome.report.overall.verdict} (${retestEval.passCount}/3)`);
        }
    }

    const leaderboard = survivors.map((result, index) => ({
        rank: index + 1,
        symbol: result.symbol,
        interval: result.interval,
        strategyKey: result.strategyKey,
        compositeScore: result.compositeScore,
        robustPrecheck: result.robustPrecheck,
        oos70_30: {
            blindMedianNetProfitPercent: result.report.oos70_30.blindMedianNetProfitPercent,
            blindMedianMaxDrawdownPercent: result.report.oos70_30.blindMedianMaxDrawdownPercent,
            trainSeedPassCount: result.report.oos70_30.trainSeedPassCount,
            blindPositiveSeedCount: result.report.oos70_30.blindPositiveSeedCount,
        },
        walkForward3m1m: {
            netProfitPercent: result.report.walkForward3m1m.combinedOOS.netProfitPercent,
            maxDrawdownPercent: result.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
            walkForwardEfficiency: result.report.walkForward3m1m.walkForwardEfficiency,
            parameterStability: result.report.walkForward3m1m.parameterStability,
        },
        feeSlippageSensitivity: {
            seedPassCount: result.report.feeSlippageSensitivity.seedPassCount,
            medianNetProfitPercent: result.report.feeSlippageSensitivity.medianNetProfitPercent,
            medianMaxDrawdownPercent: result.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
        },
        reportPath: result.reportPath,
    }));

    const summary = {
        generatedAt: new Date().toISOString(),
        seeds: DEFAULT_SEEDS,
        coverage: {
            datasets: datasets.map((d) => ({ symbol: d.symbol, interval: d.interval, bars: d.bars, dataPath: d.dataPath })),
            strategyCount: strategyKeys.length,
            comboCount: total,
            completedCombos: results.length,
        },
        robustPrecheck: {
            reportPath: robustReportPath,
            goCells: Array.from(robustMap.values()).filter((v) => v.verdict === "GO").length,
            totalCells: robustMap.size,
        },
        survivors: {
            count: leaderboard.length,
            leaderboard,
        },
        nearMisses: {
            count: nearMisses.length,
            items: nearMisses,
        },
        noSurvivorRecommendation: leaderboard.length === 0
            ? "No Gold-Standard survivors found. Next sweep should add 4h and/or 15m primaries, or test new strategy variants."
            : null,
    };

    const summaryPath = path.join(sweepOutDir, "massive-alpha-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const txtLines: string[] = [];
    txtLines.push(`Massive Alpha Sweep - ${new Date().toISOString()}`);
    txtLines.push(`Combos evaluated: ${results.length}`);
    txtLines.push(`Gold-standard survivors: ${leaderboard.length}`);
    txtLines.push(`Near misses (2/3): ${nearMisses.length}`);
    txtLines.push("");
    txtLines.push("Survivor Leaderboard:");
    if (leaderboard.length === 0) {
        txtLines.push("  none");
    } else {
        for (const row of leaderboard) {
            txtLines.push(
                `  #${row.rank} ${row.symbol} ${row.interval} ${row.strategyKey} | score=${row.compositeScore.toFixed(2)} | ` +
                `OOS blind med=${row.oos70_30.blindMedianNetProfitPercent.toFixed(2)}% | WF OOS=${row.walkForward3m1m.netProfitPercent.toFixed(2)}% DD=${row.walkForward3m1m.maxDrawdownPercent.toFixed(2)}% | ` +
                `Fee/Slip med=${row.feeSlippageSensitivity.medianNetProfitPercent.toFixed(2)}%`
            );
        }
    }
    txtLines.push("");
    txtLines.push("Near Misses:");
    if (nearMisses.length === 0) {
        txtLines.push("  none");
    } else {
        for (const miss of nearMisses) {
            const retestPass = miss.retests.find((r) => r.verdict === "PASS");
            txtLines.push(
                `  ${miss.symbol} ${miss.interval} ${miss.strategyKey} | failed=${miss.failedTest} | barely=${miss.barelyMissed ? "yes" : "no"} | retestFix=${retestPass ? `${retestPass.toInterval}` : "none"}`
            );
        }
    }

    const txtPath = path.join(sweepOutDir, "massive-alpha-summary.txt");
    fs.writeFileSync(txtPath, `${txtLines.join("\n")}\n`, "utf8");

    console.log(`[sweep] Wrote summary: ${summaryPath}`);
    console.log(`[sweep] Wrote text summary: ${txtPath}`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`massive-alpha-sweep failed: ${message}`);
    process.exitCode = 1;
});
