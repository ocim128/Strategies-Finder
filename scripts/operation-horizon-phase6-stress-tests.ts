import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runStrategyStressTests, type StressReport } from "./sol-survivor-stress-tests";
import type { BacktestSettings } from "../lib/types/strategies";

type StressTarget = {
    id: string;
    strategyKey: string;
    dataPath: string;
    tickSize: number;
    backtestSettingsOverrides?: Partial<BacktestSettings>;
    walkForwardOptimizationWindowBars?: number;
    walkForwardTestWindowBars?: number;
    walkForwardMaxCombinations?: number;
};

type StressRun = {
    target: StressTarget;
    report: StressReport;
    reportPath: string;
};

async function runTarget(target: StressTarget, outDir: string): Promise<StressRun> {
    const result = await runStrategyStressTests({
        dataPath: target.dataPath,
        strategyKey: target.strategyKey,
        tickSize: target.tickSize,
        seeds: [1337, 7331, 2026, 4242, 9001],
        outputDir: outDir,
        outputFileName: `${target.id}.json`,
        backtestSettingsOverrides: target.backtestSettingsOverrides,
        walkForwardOptimizationWindowBars: target.walkForwardOptimizationWindowBars,
        walkForwardTestWindowBars: target.walkForwardTestWindowBars,
        walkForwardMaxCombinations: target.walkForwardMaxCombinations,
        quiet: true,
    });
    return {
        target,
        report: result.report,
        reportPath: result.outPath,
    };
}

function pct(value: number): string {
    return `${value.toFixed(2)}%`;
}

async function main(): Promise<void> {
    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(`batch-runs/operation-horizon-phase6-stress-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });

    const targets: StressTarget[] = [
        {
            id: "eth-4h-meta_harvest_v3",
            strategyKey: "meta_harvest_v3",
            dataPath: "price-data/robust-lab/generated/operation-horizon-2026-02-15/ETHUSDT-4h.json",
            tickSize: 0.01,
            backtestSettingsOverrides: { tradeDirection: "both" },
        },
        {
            id: "eth-1h-simple_regression_line",
            strategyKey: "simple_regression_line",
            dataPath: "price-data/robust-lab/generated/operation-horizon-phase6-2026-02-15/ETHUSDT-1h.json",
            tickSize: 0.01,
            backtestSettingsOverrides: { tradeDirection: "both" },
            walkForwardOptimizationWindowBars: 24 * 20,
            walkForwardTestWindowBars: 24 * 10,
            walkForwardMaxCombinations: 180,
        },
    ];

    const runs: StressRun[] = [];
    for (const target of targets) {
        runs.push(await runTarget(target, outDir));
    }

    const metaRun = runs.find((run) => run.target.strategyKey === "meta_harvest_v3");
    const metaPf = metaRun?.report.feeSlippageSensitivity.medianProfitFactor ?? 0;
    const metaDd = metaRun?.report.feeSlippageSensitivity.medianMaxDrawdownPercent ?? Number.POSITIVE_INFINITY;
    const bankerGate = {
        minProfitFactor: 1.5,
        maxDrawdownPercent: 35,
    };
    const stretchGate = {
        minProfitFactor: 2.5,
    };
    const bankerGatePass = metaPf > bankerGate.minProfitFactor && metaDd < bankerGate.maxDrawdownPercent;
    const stretchPass = metaPf > stretchGate.minProfitFactor;

    const summary = {
        generatedAt: new Date().toISOString(),
        outDir,
        metaHarvestV3Gate: {
            bankerGate: {
                required: bankerGate,
                observed: {
                    medianProfitFactor: metaPf,
                    medianMaxDrawdownPercent: metaDd,
                },
                verdict: bankerGatePass ? "PROMOTE" : "HOLD",
            },
            stretchGoal: {
                required: stretchGate,
                observed: {
                    medianProfitFactor: metaPf,
                },
                verdict: stretchPass ? "PASS" : "MISS",
            },
        },
        runs: runs.map((run) => ({
            id: run.target.id,
            strategyKey: run.target.strategyKey,
            dataPath: path.resolve(run.target.dataPath),
            overallVerdict: run.report.overall.verdict,
            oos70_30: {
                verdict: run.report.oos70_30.verdict,
                blindMedianNetProfitPercent: run.report.oos70_30.blindMedianNetProfitPercent,
                blindMedianProfitFactor: run.report.oos70_30.blindMedianProfitFactor,
                blindMedianMaxDrawdownPercent: run.report.oos70_30.blindMedianMaxDrawdownPercent,
            },
            walkForward3m1m: {
                verdict: run.report.walkForward3m1m.verdict,
                netProfitPercent: run.report.walkForward3m1m.combinedOOS.netProfitPercent,
                profitFactor: run.report.walkForward3m1m.combinedOOS.profitFactor,
                maxDrawdownPercent: run.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
            },
            feeSlippageSensitivity: {
                verdict: run.report.feeSlippageSensitivity.verdict,
                medianNetProfitPercent: run.report.feeSlippageSensitivity.medianNetProfitPercent,
                medianProfitFactor: run.report.feeSlippageSensitivity.medianProfitFactor,
                medianMaxDrawdownPercent: run.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
            },
            reportPath: run.reportPath,
        })),
    };

    const summaryPath = path.join(outDir, "operation-horizon-phase6-stress-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const lines: string[] = [];
    lines.push(`Operation Horizon Phase 6 Stress Summary (${new Date().toISOString()})`);
    lines.push(`Meta Harvest v3 banker gate: ${summary.metaHarvestV3Gate.bankerGate.verdict}`);
    lines.push(
        `  observed fee/slip median PF=${summary.metaHarvestV3Gate.bankerGate.observed.medianProfitFactor.toFixed(2)} ` +
        `DD=${pct(summary.metaHarvestV3Gate.bankerGate.observed.medianMaxDrawdownPercent)}`
    );
    lines.push(`Meta Harvest v3 stretch PF>2.5: ${summary.metaHarvestV3Gate.stretchGoal.verdict}`);
    for (const run of summary.runs) {
        lines.push(
            `${run.strategyKey} | overall=${run.overallVerdict} ` +
            `| oos=${run.oos70_30.verdict} (net=${pct(run.oos70_30.blindMedianNetProfitPercent)} PF=${run.oos70_30.blindMedianProfitFactor.toFixed(2)} DD=${pct(run.oos70_30.blindMedianMaxDrawdownPercent)}) ` +
            `| wf=${run.walkForward3m1m.verdict} (net=${pct(run.walkForward3m1m.netProfitPercent)} PF=${run.walkForward3m1m.profitFactor.toFixed(2)} DD=${pct(run.walkForward3m1m.maxDrawdownPercent)}) ` +
            `| fee=${run.feeSlippageSensitivity.verdict} (net=${pct(run.feeSlippageSensitivity.medianNetProfitPercent)} PF=${run.feeSlippageSensitivity.medianProfitFactor.toFixed(2)} DD=${pct(run.feeSlippageSensitivity.medianMaxDrawdownPercent)})`
        );
    }
    const summaryTxtPath = path.join(outDir, "operation-horizon-phase6-stress-summary.txt");
    fs.writeFileSync(summaryTxtPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[phase6-stress] wrote ${summaryPath}`);
    console.log(`[phase6-stress] wrote ${summaryTxtPath}`);
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`operation-horizon-phase6-stress-tests failed: ${message}`);
        process.exitCode = 1;
    });
}
