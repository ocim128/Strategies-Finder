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
    const outDir = path.resolve(`batch-runs/operation-horizon-phase7-stress-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });

    const targets: StressTarget[] = [
        {
            id: "sol-15m-volatility_compression_break_v2",
            strategyKey: "volatility_compression_break_v2",
            dataPath: "price-data/robust-lab/generated/operation-horizon-2026-02-15/SOLUSDT-15m.json",
            tickSize: 0.01,
            backtestSettingsOverrides: { tradeDirection: "both" },
        },
        {
            id: "eth-1h-mtf_impulse_zone_reversal",
            strategyKey: "mtf_impulse_zone_reversal",
            dataPath: "price-data/robust-lab/generated/operation-horizon-phase7-2026-02-15/ETHUSDT-1h.json",
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

    const sprinterRun = runs.find((run) => run.target.strategyKey === "volatility_compression_break_v2");
    const sprinterPf = sprinterRun?.report.feeSlippageSensitivity.medianProfitFactor ?? 0;
    const sprinterDd = sprinterRun?.report.feeSlippageSensitivity.medianMaxDrawdownPercent ?? Number.POSITIVE_INFINITY;
    const bankerGate = {
        minProfitFactor: 1.5,
        maxDrawdownPercent: 35,
    };
    const bankerGatePass = sprinterPf > bankerGate.minProfitFactor && sprinterDd < bankerGate.maxDrawdownPercent;

    const summary = {
        generatedAt: new Date().toISOString(),
        outDir,
        volatilityCompressionV2Gate: {
            bankerGate: {
                required: bankerGate,
                observed: {
                    medianProfitFactor: sprinterPf,
                    medianMaxDrawdownPercent: sprinterDd,
                },
                verdict: bankerGatePass ? "PROMOTE" : "HOLD",
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

    const summaryPath = path.join(outDir, "operation-horizon-phase7-stress-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const lines: string[] = [];
    lines.push(`Operation Horizon Phase 7 Stress Summary (${new Date().toISOString()})`);
    lines.push(`Volatility Compression Break v2 banker gate: ${summary.volatilityCompressionV2Gate.bankerGate.verdict}`);
    lines.push(
        `  observed fee/slip median PF=${summary.volatilityCompressionV2Gate.bankerGate.observed.medianProfitFactor.toFixed(2)} ` +
        `DD=${pct(summary.volatilityCompressionV2Gate.bankerGate.observed.medianMaxDrawdownPercent)}`
    );
    for (const run of summary.runs) {
        lines.push(
            `${run.strategyKey} | overall=${run.overallVerdict} ` +
            `| oos=${run.oos70_30.verdict} (net=${pct(run.oos70_30.blindMedianNetProfitPercent)} PF=${run.oos70_30.blindMedianProfitFactor.toFixed(2)} DD=${pct(run.oos70_30.blindMedianMaxDrawdownPercent)}) ` +
            `| wf=${run.walkForward3m1m.verdict} (net=${pct(run.walkForward3m1m.netProfitPercent)} PF=${run.walkForward3m1m.profitFactor.toFixed(2)} DD=${pct(run.walkForward3m1m.maxDrawdownPercent)}) ` +
            `| fee=${run.feeSlippageSensitivity.verdict} (net=${pct(run.feeSlippageSensitivity.medianNetProfitPercent)} PF=${run.feeSlippageSensitivity.medianProfitFactor.toFixed(2)} DD=${pct(run.feeSlippageSensitivity.medianMaxDrawdownPercent)})`
        );
    }
    const summaryTxtPath = path.join(outDir, "operation-horizon-phase7-stress-summary.txt");
    fs.writeFileSync(summaryTxtPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[phase7-stress] wrote ${summaryPath}`);
    console.log(`[phase7-stress] wrote ${summaryTxtPath}`);
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`operation-horizon-phase7-stress-tests failed: ${message}`);
        process.exitCode = 1;
    });
}
