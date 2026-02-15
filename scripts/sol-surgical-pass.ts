import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runStrategyStressTests, type StressReport } from "./sol-survivor-stress-tests";
import type { BacktestSettings, TradeFilterMode, StrategyParams } from "../lib/types/strategies";

type OosKnobPreset = {
    id: string;
    finderMinTrades: number;
    finderRangePercent: number;
    finderSteps: number;
    finderTopN: number;
};

type ChallengerPreset = {
    id: string;
    finderMinTrades: number;
    finderRangePercent: number;
    finderSteps: number;
    finderTopN: number;
    tradeFilterMode: TradeFilterMode;
    confirmLookback: number;
};

type ParameterHit = {
    source: "feeSlippageSensitivity" | "oosBlind";
    presetId: string;
    seed: number;
    profitFactor: number;
    winRate: number;
    maxDrawdownPercent: number;
    netProfitPercent: number;
    params: StrategyParams;
};

const DATA_PATH = "price-data/robust-lab/generated/strategy-evolution-2026-02-15-btc-sol-15m-4h/SOLUSDT-4h.json";
const STRATEGY_DYNAMIC = "dynamic_vix_regime_iron_core";
const STRATEGY_CHALLENGER = "liquidity_sweep_reclaim";
const TICK_SIZE = 0.01;
const SEEDS = [1337, 7331, 2026, 4242, 9001];
const FINDER_MAX_RUNS_CAP = 50;
const DYNAMIC_MAX_POSITION_SIZE_PERCENT = 50;
const MONEY_HUNT_MIN_PF = 1.5;
const MONEY_HUNT_MIN_WIN_RATE = 45;

const dynamicRiskBase: Partial<BacktestSettings> = {
    riskMode: "simple",
    stopLossAtr: 2.5,
    takeProfitAtr: 0,
    trailingAtr: 0,
    timeStopBars: 0,
    tradeFilterMode: "adx",
    adxMin: 20,
    adxMax: 0,
};

const OOS_PRESETS: OosKnobPreset[] = [
    { id: "oos-p1", finderMinTrades: 24, finderRangePercent: 18, finderSteps: 2, finderTopN: 8 },
    { id: "oos-p2", finderMinTrades: 28, finderRangePercent: 20, finderSteps: 2, finderTopN: 8 },
    { id: "oos-p3", finderMinTrades: 32, finderRangePercent: 22, finderSteps: 2, finderTopN: 10 },
    { id: "oos-p4", finderMinTrades: 36, finderRangePercent: 24, finderSteps: 2, finderTopN: 10 },
    { id: "oos-p5", finderMinTrades: 28, finderRangePercent: 28, finderSteps: 2, finderTopN: 10 },
    { id: "oos-p6", finderMinTrades: 32, finderRangePercent: 28, finderSteps: 2, finderTopN: 10 },
    { id: "oos-p7", finderMinTrades: 36, finderRangePercent: 30, finderSteps: 2, finderTopN: 12 },
    { id: "oos-p8", finderMinTrades: 24, finderRangePercent: 24, finderSteps: 3, finderTopN: 10 },
    { id: "oos-p9", finderMinTrades: 28, finderRangePercent: 26, finderSteps: 3, finderTopN: 10 },
    { id: "oos-p10", finderMinTrades: 32, finderRangePercent: 28, finderSteps: 3, finderTopN: 12 },
];

const CHALLENGER_PRESETS: ChallengerPreset[] = [
    { id: "liq-p1", finderMinTrades: 24, finderRangePercent: 110, finderSteps: 3, finderTopN: 10, tradeFilterMode: "none", confirmLookback: 1 },
    { id: "liq-p2", finderMinTrades: 28, finderRangePercent: 110, finderSteps: 3, finderTopN: 12, tradeFilterMode: "none", confirmLookback: 1 },
    { id: "liq-p3", finderMinTrades: 32, finderRangePercent: 110, finderSteps: 3, finderTopN: 12, tradeFilterMode: "none", confirmLookback: 1 },
];

function countPasses(report: StressReport): number {
    let passCount = 0;
    if (report.oos70_30.verdict === "PASS") passCount++;
    if (report.walkForward3m1m.verdict === "PASS") passCount++;
    if (report.feeSlippageSensitivity.verdict === "PASS") passCount++;
    return passCount;
}

function toSortedParamKey(params: StrategyParams): string {
    const entries = Object.entries(params)
        .filter(([, v]) => Number.isFinite(Number(v)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${Number(v).toFixed(8)}`);
    return entries.join("|");
}

function collectHitsFromDynamicPreset(presetId: string, report: StressReport): ParameterHit[] {
    const hits: ParameterHit[] = [];

    for (const row of report.feeSlippageSensitivity.seedRuns) {
        if (!row.passed || !row.result || !row.params) continue;
        if (row.result.profitFactor > MONEY_HUNT_MIN_PF && row.result.winRate > MONEY_HUNT_MIN_WIN_RATE) {
            hits.push({
                source: "feeSlippageSensitivity",
                presetId,
                seed: row.seed,
                profitFactor: row.result.profitFactor,
                winRate: row.result.winRate,
                maxDrawdownPercent: row.result.maxDrawdownPercent,
                netProfitPercent: row.result.netProfitPercent,
                params: row.params,
            });
        }
    }

    for (const row of report.oos70_30.seedRuns) {
        const blind = row.blindResult;
        if (!row.params || !blind) continue;
        if (blind.profitFactor > MONEY_HUNT_MIN_PF && blind.winRate > MONEY_HUNT_MIN_WIN_RATE) {
            hits.push({
                source: "oosBlind",
                presetId,
                seed: row.seed,
                profitFactor: blind.profitFactor,
                winRate: blind.winRate,
                maxDrawdownPercent: blind.maxDrawdownPercent,
                netProfitPercent: blind.netProfitPercent,
                params: row.params,
            });
        }
    }

    return hits;
}

async function runDynamicOosSweep(outDir: string): Promise<{
    rows: Array<{ preset: OosKnobPreset; reportPath: string; report: StressReport; passCount: number }>;
    ddPfHits: ParameterHit[];
}> {
    const rows: Array<{ preset: OosKnobPreset; reportPath: string; report: StressReport; passCount: number }> = [];
    const ddPfHits: ParameterHit[] = [];

    const sweepDir = path.join(outDir, "dynamic-vix-oos-tuning");
    fs.mkdirSync(sweepDir, { recursive: true });

    for (const preset of OOS_PRESETS) {
        const reportFileName = `${preset.id}.json`;
        const { report, outPath } = await runStrategyStressTests({
            dataPath: DATA_PATH,
            strategyKey: STRATEGY_DYNAMIC,
            tickSize: TICK_SIZE,
            positionSizePercent: DYNAMIC_MAX_POSITION_SIZE_PERCENT,
            seeds: SEEDS,
            finderMaxRuns: FINDER_MAX_RUNS_CAP,
            finderRangePercent: preset.finderRangePercent,
            finderSteps: preset.finderSteps,
            finderTopN: preset.finderTopN,
            finderMinTrades: preset.finderMinTrades,
            backtestSettingsOverrides: {
                ...dynamicRiskBase,
                tradeFilterMode: "adx",
                adxMin: 20,
                adxMax: 0,
                confirmLookback: 1,
            },
            outputDir: sweepDir,
            outputFileName: reportFileName,
            quiet: true,
        });
        const passCount = countPasses(report);
        rows.push({ preset, reportPath: outPath, report, passCount });
        ddPfHits.push(...collectHitsFromDynamicPreset(preset.id, report));
        console.log(
            `[dynamic-oos] ${preset.id} filter=adx/20 minTrades=${preset.finderMinTrades}` +
            ` range=${preset.finderRangePercent}% steps=${preset.finderSteps} topN=${preset.finderTopN}` +
            ` maxRuns=${FINDER_MAX_RUNS_CAP} => ${report.overall.verdict} (${passCount}/3)`
        );
    }

    const dedup = new Map<string, ParameterHit>();
    for (const hit of ddPfHits) {
        const key = `${hit.source}|${hit.seed}|${toSortedParamKey(hit.params)}`;
        const prev = dedup.get(key);
        if (!prev || hit.netProfitPercent > prev.netProfitPercent) dedup.set(key, hit);
    }

    return {
        rows,
        ddPfHits: Array.from(dedup.values()).sort((a, b) =>
            b.netProfitPercent - a.netProfitPercent ||
            b.profitFactor - a.profitFactor ||
            a.maxDrawdownPercent - b.maxDrawdownPercent
        ),
    };
}

async function runKellyControlVerification(
    outDir: string,
    preset: OosKnobPreset | null | undefined
): Promise<{ reportPath: string; report: StressReport } | null> {
    if (!preset) return null;
    const kellyDir = path.join(outDir, "dynamic-vix-kelly-control");
    fs.mkdirSync(kellyDir, { recursive: true });
    const reportFileName = `kelly-${preset.id}.json`;
    const outcome = await runStrategyStressTests({
        dataPath: DATA_PATH,
        strategyKey: STRATEGY_DYNAMIC,
        tickSize: TICK_SIZE,
        seeds: SEEDS,
        positionSizePercent: DYNAMIC_MAX_POSITION_SIZE_PERCENT,
        finderMaxRuns: FINDER_MAX_RUNS_CAP,
        finderRangePercent: preset.finderRangePercent,
        finderSteps: preset.finderSteps,
        finderTopN: preset.finderTopN,
        finderMinTrades: preset.finderMinTrades,
        backtestSettingsOverrides: {
            ...dynamicRiskBase,
            // Engine has no direct riskPercent field; keep ATR exits and enforce 50% max size.
            riskMode: "percentage",
            stopLossEnabled: false,
            takeProfitEnabled: false,
            stopLossPercent: 1,
            takeProfitPercent: 0,
            tradeFilterMode: "adx",
            adxMin: 20,
            adxMax: 0,
            confirmLookback: 1,
        },
        outputDir: kellyDir,
        outputFileName: reportFileName,
        quiet: true,
    });
    console.log(
        `[kelly] ${preset.id} mode=percentage riskPercent=1.0(proxy) maxPos=${DYNAMIC_MAX_POSITION_SIZE_PERCENT}%` +
        ` => ${outcome.report.overall.verdict} (oos=${outcome.report.oos70_30.verdict}, wf=${outcome.report.walkForward3m1m.verdict}, fee=${outcome.report.feeSlippageSensitivity.verdict})`
    );
    return { reportPath: outcome.outPath, report: outcome.report };
}

async function runChallengerSweep(outDir: string): Promise<Array<{ preset: ChallengerPreset; reportPath: string; report: StressReport; passCount: number }>> {
    const rows: Array<{ preset: ChallengerPreset; reportPath: string; report: StressReport; passCount: number }> = [];
    const challengerDir = path.join(outDir, "liquidity-sweep-reclaim");
    fs.mkdirSync(challengerDir, { recursive: true });

    for (const preset of CHALLENGER_PRESETS) {
        const reportFileName = `${preset.id}.json`;
        const { report, outPath } = await runStrategyStressTests({
            dataPath: DATA_PATH,
            strategyKey: STRATEGY_CHALLENGER,
            tickSize: TICK_SIZE,
            seeds: SEEDS,
            finderMaxRuns: FINDER_MAX_RUNS_CAP,
            finderRangePercent: preset.finderRangePercent,
            finderSteps: preset.finderSteps,
            finderTopN: preset.finderTopN,
            finderMinTrades: preset.finderMinTrades,
            backtestSettingsOverrides: {
                tradeFilterMode: preset.tradeFilterMode,
                confirmLookback: preset.confirmLookback,
            },
            outputDir: challengerDir,
            outputFileName: reportFileName,
            quiet: true,
        });
        const passCount = countPasses(report);
        rows.push({ preset, reportPath: outPath, report, passCount });
        console.log(
            `[liquidity] ${preset.id} minTrades=${preset.finderMinTrades}` +
            ` range=${preset.finderRangePercent}% steps=${preset.finderSteps} topN=${preset.finderTopN}` +
            ` maxRuns=${FINDER_MAX_RUNS_CAP} => ${report.overall.verdict} (${passCount}/3)`
        );
    }
    return rows;
}

async function main(): Promise<void> {
    const dateTag = new Date().toISOString().slice(0, 10);
    const outDir = path.resolve(`batch-runs/sol-iron-core-pass-${dateTag}`);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`[surgical] dataset=${path.resolve(DATA_PATH)} strategyLead=${STRATEGY_DYNAMIC} stopLossAtr=2.50`);
    console.log(`[surgical] finder maxRuns cap=${FINDER_MAX_RUNS_CAP}`);
    console.log(`[surgical] dynamic maxPositionSize=${DYNAMIC_MAX_POSITION_SIZE_PERCENT}%`);

    const dynamic = await runDynamicOosSweep(outDir);
    const dynamicBestPreset = dynamic.rows.slice().sort((a, b) =>
        b.passCount - a.passCount ||
        (b.report.oos70_30.verdict === "PASS" ? 1 : 0) - (a.report.oos70_30.verdict === "PASS" ? 1 : 0) ||
        b.report.oos70_30.blindMedianProfitFactor - a.report.oos70_30.blindMedianProfitFactor ||
        b.report.oos70_30.blindMedianNetProfitPercent - a.report.oos70_30.blindMedianNetProfitPercent
    )[0]?.preset;
    const kellyVerification = await runKellyControlVerification(outDir, dynamicBestPreset);
    const challenger = await runChallengerSweep(outDir);

    const dynamicBest = dynamic.rows.slice().sort((a, b) =>
        b.passCount - a.passCount ||
        (b.report.oos70_30.verdict === "PASS" ? 1 : 0) - (a.report.oos70_30.verdict === "PASS" ? 1 : 0) ||
        b.report.oos70_30.blindMedianNetProfitPercent - a.report.oos70_30.blindMedianNetProfitPercent ||
        b.report.feeSlippageSensitivity.medianProfitFactor - a.report.feeSlippageSensitivity.medianProfitFactor
    )[0];

    const challengerBest = challenger.slice().sort((a, b) =>
        b.passCount - a.passCount ||
        b.report.oos70_30.blindMedianNetProfitPercent - a.report.oos70_30.blindMedianNetProfitPercent ||
        b.report.walkForward3m1m.walkForwardEfficiency - a.report.walkForward3m1m.walkForwardEfficiency ||
        b.report.feeSlippageSensitivity.medianProfitFactor - a.report.feeSlippageSensitivity.medianProfitFactor
    )[0];

    const summary = {
        generatedAt: new Date().toISOString(),
        scope: {
            dataPath: path.resolve(DATA_PATH),
            symbol: "SOLUSDT",
            interval: "4h",
            seeds: SEEDS,
            finderMaxRunsCap: FINDER_MAX_RUNS_CAP,
            dynamicMaxPositionSizePercent: DYNAMIC_MAX_POSITION_SIZE_PERCENT,
        },
        step1DynamicVixOosTuning: {
            strategyKey: STRATEGY_DYNAMIC,
            fixedRisk: dynamicRiskBase,
            presets: dynamic.rows.map((row) => ({
                preset: row.preset,
                passCount: row.passCount,
                overallVerdict: row.report.overall.verdict,
                oosVerdict: row.report.oos70_30.verdict,
                wfVerdict: row.report.walkForward3m1m.verdict,
                feeVerdict: row.report.feeSlippageSensitivity.verdict,
                oosBlindMedianNetProfitPercent: row.report.oos70_30.blindMedianNetProfitPercent,
                oosBlindMedianMaxDrawdownPercent: row.report.oos70_30.blindMedianMaxDrawdownPercent,
                oosBlindMedianProfitFactor: row.report.oos70_30.blindMedianProfitFactor,
                wfCombinedNetProfitPercent: row.report.walkForward3m1m.combinedOOS.netProfitPercent,
                wfCombinedMaxDrawdownPercent: row.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
                wfCombinedProfitFactor: row.report.walkForward3m1m.combinedOOS.profitFactor,
                feeMedianNetProfitPercent: row.report.feeSlippageSensitivity.medianNetProfitPercent,
                feeMedianMaxDrawdownPercent: row.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
                feeMedianProfitFactor: row.report.feeSlippageSensitivity.medianProfitFactor,
                reportPath: row.reportPath,
            })),
            bestPreset: dynamicBest
                ? {
                    preset: dynamicBest.preset,
                    passCount: dynamicBest.passCount,
                    overallVerdict: dynamicBest.report.overall.verdict,
                    oosVerdict: dynamicBest.report.oos70_30.verdict,
                    wfVerdict: dynamicBest.report.walkForward3m1m.verdict,
                    feeVerdict: dynamicBest.report.feeSlippageSensitivity.verdict,
                    reportPath: dynamicBest.reportPath,
                }
                : null,
        },
        step2LiquiditySweepReclaim: {
            strategyKey: STRATEGY_CHALLENGER,
            presets: challenger.map((row) => ({
                preset: row.preset,
                passCount: row.passCount,
                overallVerdict: row.report.overall.verdict,
                oosVerdict: row.report.oos70_30.verdict,
                wfVerdict: row.report.walkForward3m1m.verdict,
                feeVerdict: row.report.feeSlippageSensitivity.verdict,
                oosBlindMedianNetProfitPercent: row.report.oos70_30.blindMedianNetProfitPercent,
                oosBlindMedianMaxDrawdownPercent: row.report.oos70_30.blindMedianMaxDrawdownPercent,
                oosBlindMedianProfitFactor: row.report.oos70_30.blindMedianProfitFactor,
                wfCombinedNetProfitPercent: row.report.walkForward3m1m.combinedOOS.netProfitPercent,
                wfCombinedMaxDrawdownPercent: row.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
                wfCombinedProfitFactor: row.report.walkForward3m1m.combinedOOS.profitFactor,
                wfEfficiency: row.report.walkForward3m1m.walkForwardEfficiency,
                feeMedianNetProfitPercent: row.report.feeSlippageSensitivity.medianNetProfitPercent,
                feeMedianMaxDrawdownPercent: row.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
                feeMedianProfitFactor: row.report.feeSlippageSensitivity.medianProfitFactor,
                reportPath: row.reportPath,
            })),
            bestPreset: challengerBest
                ? {
                    preset: challengerBest.preset,
                    passCount: challengerBest.passCount,
                    overallVerdict: challengerBest.report.overall.verdict,
                    oosVerdict: challengerBest.report.oos70_30.verdict,
                    wfVerdict: challengerBest.report.walkForward3m1m.verdict,
                    feeVerdict: challengerBest.report.feeSlippageSensitivity.verdict,
                    reportPath: challengerBest.reportPath,
                }
                : null,
        },
        step3RealMoneyHunt: {
            target: { profitFactorGt: MONEY_HUNT_MIN_PF, winRateGt: MONEY_HUNT_MIN_WIN_RATE },
            dynamicVixHits: dynamic.ddPfHits,
            found: dynamic.ddPfHits.length > 0,
        },
        step4KellyControlVerification: kellyVerification
            ? {
                strategyKey: STRATEGY_DYNAMIC,
                basedOnPreset: dynamicBestPreset ?? null,
                config: {
                    riskMode: "percentage",
                    riskPercentProxy: 1.0,
                    maxPositionSizePercent: DYNAMIC_MAX_POSITION_SIZE_PERCENT,
                    stopLossAtr: dynamicRiskBase.stopLossAtr ?? null,
                    tradeFilterMode: "adx",
                    adxMin: 20,
                },
                overallVerdict: kellyVerification.report.overall.verdict,
                oosVerdict: kellyVerification.report.oos70_30.verdict,
                wfVerdict: kellyVerification.report.walkForward3m1m.verdict,
                feeVerdict: kellyVerification.report.feeSlippageSensitivity.verdict,
                oosBlindMedianNetProfitPercent: kellyVerification.report.oos70_30.blindMedianNetProfitPercent,
                oosBlindMedianMaxDrawdownPercent: kellyVerification.report.oos70_30.blindMedianMaxDrawdownPercent,
                oosBlindMedianProfitFactor: kellyVerification.report.oos70_30.blindMedianProfitFactor,
                wfCombinedNetProfitPercent: kellyVerification.report.walkForward3m1m.combinedOOS.netProfitPercent,
                wfCombinedMaxDrawdownPercent: kellyVerification.report.walkForward3m1m.combinedOOS.maxDrawdownPercent,
                wfCombinedProfitFactor: kellyVerification.report.walkForward3m1m.combinedOOS.profitFactor,
                feeMedianNetProfitPercent: kellyVerification.report.feeSlippageSensitivity.medianNetProfitPercent,
                feeMedianMaxDrawdownPercent: kellyVerification.report.feeSlippageSensitivity.medianMaxDrawdownPercent,
                feeMedianProfitFactor: kellyVerification.report.feeSlippageSensitivity.medianProfitFactor,
                reportPath: kellyVerification.reportPath,
            }
            : null,
    };

    const summaryPath = path.join(outDir, "sol-surgical-pass-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    const lines: string[] = [];
    lines.push(`SOL Iron Core Pass ${new Date().toISOString()}`);
    lines.push(`Data: ${path.resolve(DATA_PATH)}`);
    lines.push(`Finder maxRuns cap: ${FINDER_MAX_RUNS_CAP}`);
    lines.push(`Dynamic max position size: ${DYNAMIC_MAX_POSITION_SIZE_PERCENT}%`);
    lines.push("");
    lines.push("Step 1: Dynamic VIX Iron Core OOS tuning (stopLossAtr=2.50, ADX filter forced)");
    for (const row of summary.step1DynamicVixOosTuning.presets) {
        lines.push(
            `  ${row.preset.id} | pass=${row.passCount}/3 | oos=${row.oosVerdict} wf=${row.wfVerdict} fee=${row.feeVerdict}` +
            ` | blindNet=${row.oosBlindMedianNetProfitPercent.toFixed(2)}% blindPF=${row.oosBlindMedianProfitFactor.toFixed(2)}`
        );
    }
    lines.push("");
    lines.push("Step 2: Liquidity Sweep Reclaim");
    for (const row of summary.step2LiquiditySweepReclaim.presets) {
        lines.push(
            `  ${row.preset.id} | pass=${row.passCount}/3 | oos=${row.oosVerdict} wf=${row.wfVerdict} fee=${row.feeVerdict}` +
            ` | blindNet=${row.oosBlindMedianNetProfitPercent.toFixed(2)}% wfWFE=${row.wfEfficiency.toFixed(3)} feePF=${row.feeMedianProfitFactor.toFixed(2)}`
        );
    }
    lines.push("");
    lines.push(`Step 3: PF>${MONEY_HUNT_MIN_PF} and WinRate>${MONEY_HUNT_MIN_WIN_RATE}% hunt (${STRATEGY_DYNAMIC})`);
    lines.push(`  hits=${summary.step3RealMoneyHunt.dynamicVixHits.length}`);
    for (const hit of summary.step3RealMoneyHunt.dynamicVixHits.slice(0, 8)) {
        lines.push(
            `  ${hit.source} ${hit.presetId} seed=${hit.seed} | PF=${hit.profitFactor.toFixed(2)} WR=${hit.winRate.toFixed(2)}% DD=${hit.maxDrawdownPercent.toFixed(2)}% net=${hit.netProfitPercent.toFixed(2)}%`
        );
    }
    lines.push("");
    lines.push("Step 4: Kelly Control Verification");
    if (!summary.step4KellyControlVerification) {
        lines.push("  no verification run");
    } else {
        const row = summary.step4KellyControlVerification;
        lines.push(
            `  preset=${row.basedOnPreset?.id ?? "n/a"} | overall=${row.overallVerdict}` +
            ` | oos=${row.oosVerdict} wf=${row.wfVerdict} fee=${row.feeVerdict}`
        );
        lines.push(
            `  OOS blind net=${row.oosBlindMedianNetProfitPercent.toFixed(2)}% PF=${row.oosBlindMedianProfitFactor.toFixed(2)}` +
            ` DD=${row.oosBlindMedianMaxDrawdownPercent.toFixed(2)}% | WF DD=${row.wfCombinedMaxDrawdownPercent.toFixed(2)}%`
        );
    }
    const txtPath = path.join(outDir, "sol-surgical-pass-summary.txt");
    fs.writeFileSync(txtPath, `${lines.join("\n")}\n`, "utf8");

    console.log(`[surgical] wrote ${summaryPath}`);
    console.log(`[surgical] wrote ${txtPath}`);
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
})();

if (isDirectRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`sol-surgical-pass failed: ${message}`);
        process.exitCode = 1;
    });
}
