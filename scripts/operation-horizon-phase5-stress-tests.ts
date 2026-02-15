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
};

type StressRun = {
    target: StressTarget;
    report: StressReport;
    reportPath: string;
};

function pct(value: number): string {
    return `${value.toFixed(2)}%`;
}

async function runTarget(target: StressTarget, outDir: string): Promise<StressRun> {
    const result = await runStrategyStressTests({
        dataPath: target.dataPath,
        strategyKey: target.strategyKey,
        tickSize: target.tickSize,
        seeds: [1337, 7331, 2026, 4242, 9001],
        outputDir: outDir,
        outputFileName: `${target.id}.json`,
        backtestSettingsOverrides: target.backtestSettingsOverrides,
        quiet: true,
    });

    return {
        target,
        report: result.report,
        reportPath: result.outPath,
    };
}

async function main(): Promise<void> {
    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(`batch-runs/operation-horizon-phase5-stress-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });

    const targets: StressTarget[] = [
        {
            id: "btc-4h-bear_hunter_v5",
            strategyKey: "bear_hunter_v5",
            dataPath: "price-data/robust-lab/generated/operation-horizon-2026-02-15/BTCUSDT-4h.json",
            tickSize: 0.1,
            backtestSettingsOverrides: {
                tradeDirection: "short",
            },
        },
        {
            id: "eth-4h-meta_harvest_v2",
            strategyKey: "meta_harvest_v2",
            dataPath: "price-data/robust-lab/generated/operation-horizon-2026-02-15/ETHUSDT-4h.json",
            tickSize: 0.01,
            backtestSettingsOverrides: {
                tradeDirection: "both",
            },
        },
    ];

    const runs: StressRun[] = [];
    for (const target of targets) {
        runs.push(await runTarget(target, outDir));
    }

    const bearRun = runs.find((run) => run.target.strategyKey === "bear_hunter_v5");
    const bearPf = bearRun?.report.feeSlippageSensitivity.medianProfitFactor ?? 0;
    const bearDd = bearRun?.report.feeSlippageSensitivity.medianMaxDrawdownPercent ?? Number.POSITIVE_INFINITY;
    const bearPromotionGate = bearPf > 1.5 && bearDd < 35;

    const summary = {
        generatedAt: new Date().toISOString(),
        outDir,
        promotionGate: {
            strategyKey: "bear_hunter_v5",
            required: {
                minProfitFactor: 1.5,
                maxDrawdownPercent: 35,
            },
            observed: {
                medianProfitFactor: bearPf,
                medianMaxDrawdownPercent: bearDd,
            },
            verdict: bearPromotionGate ? "PROMOTE" : "HOLD",
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

    const summaryPath = path.join(outDir, "operation-horizon-phase5-stress-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const lines: string[] = [];
    lines.push(`Operation Horizon Phase 5 Stress Summary (${new Date().toISOString()})`);
    lines.push(`Bear Hunter v5 promotion gate: ${summary.promotionGate.verdict}`);
    lines.push(
        `  observed fee/slip median PF=${summary.promotionGate.observed.medianProfitFactor.toFixed(2)} ` +
        `DD=${pct(summary.promotionGate.observed.medianMaxDrawdownPercent)}`
    );
    for (const run of summary.runs) {
        lines.push(
            `${run.strategyKey} | overall=${run.overallVerdict} ` +
            `| oos=${run.oos70_30.verdict} (net=${pct(run.oos70_30.blindMedianNetProfitPercent)} PF=${run.oos70_30.blindMedianProfitFactor.toFixed(2)} DD=${pct(run.oos70_30.blindMedianMaxDrawdownPercent)}) ` +
            `| wf=${run.walkForward3m1m.verdict} (net=${pct(run.walkForward3m1m.netProfitPercent)} PF=${run.walkForward3m1m.profitFactor.toFixed(2)} DD=${pct(run.walkForward3m1m.maxDrawdownPercent)}) ` +
            `| fee=${run.feeSlippageSensitivity.verdict} (net=${pct(run.feeSlippageSensitivity.medianNetProfitPercent)} PF=${run.feeSlippageSensitivity.medianProfitFactor.toFixed(2)} DD=${pct(run.feeSlippageSensitivity.medianMaxDrawdownPercent)})`
        );
    }
    const summaryTxtPath = path.join(outDir, "operation-horizon-phase5-stress-summary.txt");
    fs.writeFileSync(summaryTxtPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[phase5-stress] wrote ${summaryPath}`);
    console.log(`[phase5-stress] wrote ${summaryTxtPath}`);
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`operation-horizon-phase5-stress-tests failed: ${message}`);
        process.exitCode = 1;
    });
}
