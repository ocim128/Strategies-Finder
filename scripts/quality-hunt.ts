import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

type CliOptions = {
    strategyKey: string;
    symbol: string;
    secondarySymbol: string;
    interval: string;
    seed: number;
    outFile: string;
    dataDir: string;
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    executionModel: "signal_close" | "next_open" | "next_close";
    tradeFilterMode: "none" | "close" | "volume" | "rsi" | "trend" | "adx" | "htf_drift";
    slippageBps: number;
    allowSameBarExit: boolean;
};

type WalkForwardReport = {
    summary: {
        initialCapital: number;
        finalCapital: number;
        totalNetProfit: number;
        totalNetProfitPercent: number;
        totalTrades: number;
        positiveWindows: number;
        negativeWindows: number;
        maxDrawdownPercent: number;
    };
    windows: Array<{
        index: number;
        train: {
            bestNetProfitPercent: number;
        };
        test: {
            endingCapital: number;
            netProfit: number;
        };
    }>;
};

type GateVerdict = {
    pass: boolean;
    reasons: string[];
};

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run hunt:quality -- --strategy bear_hunter_v5",
        "",
        "Options:",
        "  --strategy <key>            default bear_hunter_v5",
        "  --symbol <pair>             default XRPUSDT",
        "  --secondary-symbol <pair>   default SOLUSDT",
        "  --interval <value>          default 15m",
        "  --seed <n>                  default 2026",
        "  --out <file>                default quality_hunt.json",
    ].join("\n"));
}

function toFinite(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value: string | undefined, fallback: number, min = 1): number {
    const parsed = Math.floor(toFinite(value, fallback));
    return Math.max(min, parsed);
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return fallback;
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
    let strategyKey = "bear_hunter_v5";
    let symbol = "XRPUSDT";
    let secondarySymbol = "SOLUSDT";
    let interval = "15m";
    let seed = 2026;
    let outFile = path.resolve("quality_hunt.json");
    let dataDir = path.resolve("price-data", "universal");
    let initialCapital = 10000;
    let positionSize = 100;
    let commission = 0.2;
    let sizingMode: "percent" | "fixed" = "percent";
    let fixedTradeAmount = 1000;
    let executionModel: "signal_close" | "next_open" | "next_close" = "signal_close";
    let tradeFilterMode: "none" | "close" | "volume" | "rsi" | "trend" | "adx" | "htf_drift" = "none";
    let slippageBps = 0;
    let allowSameBarExit = true;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") {
            return {
                help: true,
                strategyKey,
                symbol,
                secondarySymbol,
                interval,
                seed,
                outFile,
                dataDir,
                initialCapital,
                positionSize,
                commission,
                sizingMode,
                fixedTradeAmount,
                executionModel,
                tradeFilterMode,
                slippageBps,
                allowSameBarExit,
            };
        }
        if (arg === "--strategy") { strategyKey = String(next ?? strategyKey).trim(); i++; continue; }
        if (arg === "--symbol") { symbol = String(next ?? symbol).trim().toUpperCase(); i++; continue; }
        if (arg === "--secondary-symbol") { secondarySymbol = String(next ?? secondarySymbol).trim().toUpperCase(); i++; continue; }
        if (arg === "--interval") { interval = String(next ?? interval).trim() || interval; i++; continue; }
        if (arg === "--seed") { seed = toPositiveInt(next, seed, 1); i++; continue; }
        if (arg === "--out") { outFile = path.resolve(String(next ?? outFile)); i++; continue; }
        if (arg === "--data-dir") { dataDir = path.resolve(String(next ?? dataDir)); i++; continue; }
        if (arg === "--initial-capital") { initialCapital = toFinite(next, initialCapital); i++; continue; }
        if (arg === "--position-size") { positionSize = toFinite(next, positionSize); i++; continue; }
        if (arg === "--commission") { commission = toFinite(next, commission); i++; continue; }
        if (arg === "--sizing") {
            const mode = String(next ?? "").trim().toLowerCase();
            sizingMode = mode === "fixed" ? "fixed" : "percent";
            i++;
            continue;
        }
        if (arg === "--fixed-trade-amount") { fixedTradeAmount = toFinite(next, fixedTradeAmount); i++; continue; }
        if (arg === "--execution") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "signal_close" || value === "next_open" || value === "next_close") executionModel = value;
            i++;
            continue;
        }
        if (arg === "--trade-filter") {
            const value = String(next ?? "").trim().toLowerCase();
            if (value === "none" || value === "close" || value === "volume" || value === "rsi" || value === "trend" || value === "adx" || value === "htf_drift") {
                tradeFilterMode = value;
            }
            i++;
            continue;
        }
        if (arg === "--slippage-bps") { slippageBps = toFinite(next, slippageBps); i++; continue; }
        if (arg === "--allow-same-bar-exit") { allowSameBarExit = toBoolean(next, allowSameBarExit); i++; continue; }
        positional.push(arg);
    }

    if (positional[0]) strategyKey = positional[0].trim();

    return {
        strategyKey,
        symbol,
        secondarySymbol,
        interval,
        seed,
        outFile,
        dataDir,
        initialCapital: Math.max(1, initialCapital),
        positionSize: Math.max(0.0001, positionSize),
        commission: Math.max(0, commission),
        sizingMode,
        fixedTradeAmount: Math.max(0, fixedTradeAmount),
        executionModel,
        tradeFilterMode,
        slippageBps: Math.max(0, slippageBps),
        allowSameBarExit,
    };
}

function deriveSeed(baseSeed: number, ...parts: Array<string | number>): number {
    const key = parts.join("|");
    let hash = baseSeed >>> 0;
    for (let i = 0; i < key.length; i++) {
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    }
    return (hash >>> 0) || 1;
}

function computeWindowPathMaxDrawdownPercent(report: WalkForwardReport): number {
    const initial = report.summary.initialCapital;
    let peak = initial;
    let maxDrawdownPercent = 0;
    for (const window of report.windows) {
        const value = Number(window.test.endingCapital);
        if (!Number.isFinite(value)) continue;
        if (value > peak) {
            peak = value;
            continue;
        }
        const drawdown = peak - value;
        const pct = peak > 0 ? (drawdown / peak) * 100 : 0;
        if (pct > maxDrawdownPercent) maxDrawdownPercent = pct;
    }
    return maxDrawdownPercent;
}

function evaluateStageBGate(report: WalkForwardReport, derivedDdPercent: number): GateVerdict {
    const reasons: string[] = [];
    const positiveWindows = Number(report.summary.positiveWindows);
    const windows = Math.max(1, report.windows.length);
    const positiveRate = positiveWindows / windows;
    if (!(report.summary.totalNetProfit > 0)) reasons.push("net_profit_not_positive");
    if (!(derivedDdPercent < 15)) reasons.push("max_drawdown_not_below_15");
    if (!(positiveRate >= 0.5)) reasons.push("positive_windows_rate_below_50_percent");
    return { pass: reasons.length === 0, reasons };
}

function evaluateStageDGate(derivedDdPercent: number): GateVerdict {
    const reasons: string[] = [];
    if (!(derivedDdPercent < 30)) reasons.push("max_drawdown_not_below_30");
    return { pass: reasons.length === 0, reasons };
}

function runWalkForwardStage(
    options: CliOptions,
    stageLabel: string,
    args: {
        symbol: string;
        seed: number;
        windows: number;
        trainMonths: number;
        testMonths: number;
        population: number;
        generations: number;
        outFile: string;
    }
): WalkForwardReport {
    const cmdArgs = [
        "run",
        "hunt:walk-forward",
        "--",
        "--strategy", options.strategyKey,
        "--symbol", args.symbol,
        "--interval", options.interval,
        "--windows", String(args.windows),
        "--train-months", String(args.trainMonths),
        "--test-months", String(args.testMonths),
        "--population", String(args.population),
        "--generations", String(args.generations),
        "--seed", String(args.seed),
        "--initial-capital", String(options.initialCapital),
        "--position-size", String(options.positionSize),
        "--commission", String(options.commission),
        "--sizing", options.sizingMode,
        "--fixed-trade-amount", String(options.fixedTradeAmount),
        "--execution", options.executionModel,
        "--trade-filter", options.tradeFilterMode,
        "--slippage-bps", String(options.slippageBps),
        "--allow-same-bar-exit", String(options.allowSameBarExit),
        "--data-dir", options.dataDir,
        "--out", args.outFile,
    ];

    console.log(
        `[${stageLabel}] run symbol=${args.symbol} windows=${args.windows} pop=${args.population} gen=${args.generations} seed=${args.seed}`
    );
    const run = spawnSync("npm", cmdArgs, {
        stdio: "inherit",
        shell: true,
    });
    if (run.status !== 0) {
        throw new Error(`[${stageLabel}] walk-forward execution failed with exit code ${run.status ?? -1}.`);
    }
    if (!fs.existsSync(args.outFile)) {
        throw new Error(`[${stageLabel}] expected output file was not created: ${args.outFile}`);
    }
    return JSON.parse(fs.readFileSync(args.outFile, "utf8")) as WalkForwardReport;
}

function stageTempFile(baseOutFile: string, label: string): string {
    const dir = path.dirname(baseOutFile);
    const ext = path.extname(baseOutFile) || ".json";
    const stem = path.basename(baseOutFile, ext);
    return path.resolve(dir, `${stem}.${label}${ext}`);
}

async function runQualityHunt(options: CliOptions): Promise<void> {
    const startedAt = Date.now();

    const stageASeed = deriveSeed(options.seed, options.symbol, options.strategyKey, "stage_a");
    const stageBSeed = deriveSeed(options.seed, options.symbol, options.strategyKey, "stage_b");
    const stageCSeeds = [
        deriveSeed(options.seed, options.symbol, options.strategyKey, "stage_c", 1),
        deriveSeed(options.seed, options.symbol, options.strategyKey, "stage_c", 2),
        deriveSeed(options.seed, options.symbol, options.strategyKey, "stage_c", 3),
    ];
    const stageDSeed = deriveSeed(options.seed, options.secondarySymbol, options.strategyKey, "stage_d");

    const stageAOut = stageTempFile(options.outFile, "stageA");
    const stageAReport = runWalkForwardStage(options, "StageA", {
        symbol: options.symbol,
        seed: stageASeed,
        windows: 1,
        trainMonths: 6,
        testMonths: 1,
        population: 50,
        generations: 10,
        outFile: stageAOut,
    });
    const stageATrainNet = Number(stageAReport.windows?.[0]?.train?.bestNetProfitPercent ?? Number.NEGATIVE_INFINITY);
    const stageAPass = stageATrainNet > 0;
    const stageAReasons = stageAPass ? [] : ["stage_a_train_net_profit_not_positive"];
    console.log(`[StageA] pass=${stageAPass ? "yes" : "no"} trainNet=${stageATrainNet.toFixed(2)}%`);

    const stageBOut = stageTempFile(options.outFile, "stageB");
    const stageBReport = runWalkForwardStage(options, "StageB", {
        symbol: options.symbol,
        seed: stageBSeed,
        windows: 12,
        trainMonths: 6,
        testMonths: 1,
        population: 100,
        generations: 50,
        outFile: stageBOut,
    });
    const stageBDerivedDdPercent = computeWindowPathMaxDrawdownPercent(stageBReport);
    const stageBGate = evaluateStageBGate(stageBReport, stageBDerivedDdPercent);
    console.log(
        `[StageB] pass=${stageBGate.pass ? "yes" : "no"} net=${stageBReport.summary.totalNetProfitPercent.toFixed(2)}% dd(derived)=${stageBDerivedDdPercent.toFixed(2)}% windows+=${stageBReport.summary.positiveWindows}/${stageBReport.windows.length}`
    );

    const stageCRuns: Array<{
        seed: number;
        outFile: string;
        report: WalkForwardReport;
        derivedMaxDrawdownPercent: number;
        gate: GateVerdict;
    }> = [];
    for (let i = 0; i < stageCSeeds.length; i++) {
        const seed = stageCSeeds[i];
        const outFile = stageTempFile(options.outFile, `stageC.seed${i + 1}`);
        const report = runWalkForwardStage(options, `StageC-${i + 1}`, {
            symbol: options.symbol,
            seed,
            windows: 12,
            trainMonths: 6,
            testMonths: 1,
            population: 100,
            generations: 50,
            outFile,
        });
        const derivedDd = computeWindowPathMaxDrawdownPercent(report);
        const gate = evaluateStageBGate(report, derivedDd);
        stageCRuns.push({ seed, outFile, report, derivedMaxDrawdownPercent: derivedDd, gate });
        console.log(
            `[StageC-${i + 1}] pass=${gate.pass ? "yes" : "no"} net=${report.summary.totalNetProfitPercent.toFixed(2)}% dd(derived)=${derivedDd.toFixed(2)}% windows+=${report.summary.positiveWindows}/${report.windows.length}`
        );
    }
    const stageCPass = stageCRuns.every((item) => item.gate.pass);
    const stageCReasons = stageCPass ? [] : ["stage_c_not_all_three_runs_passed"];

    const stageDOut = stageTempFile(options.outFile, "stageD");
    const stageDReport = runWalkForwardStage(options, "StageD", {
        symbol: options.secondarySymbol,
        seed: stageDSeed,
        windows: 12,
        trainMonths: 6,
        testMonths: 1,
        population: 100,
        generations: 50,
        outFile: stageDOut,
    });
    const stageDDerivedDdPercent = computeWindowPathMaxDrawdownPercent(stageDReport);
    const stageDGate = evaluateStageDGate(stageDDerivedDdPercent);
    console.log(
        `[StageD] pass=${stageDGate.pass ? "yes" : "no"} net=${stageDReport.summary.totalNetProfitPercent.toFixed(2)}% dd(derived)=${stageDDerivedDdPercent.toFixed(2)}%`
    );

    const finalPass = stageAPass && stageBGate.pass && stageCPass && stageDGate.pass;
    const report = {
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        config: {
            strategyKey: options.strategyKey,
            primarySymbol: options.symbol,
            secondarySymbol: options.secondarySymbol,
            interval: options.interval,
            seed: options.seed,
            dataDir: options.dataDir,
            outFile: options.outFile,
            stageA: {
                windows: 1,
                trainMonths: 6,
                testMonths: 1,
                population: 50,
                generations: 10,
                gate: "train_net_profit_percent > 0",
            },
            stageB: {
                windows: 12,
                trainMonths: 6,
                testMonths: 1,
                population: 100,
                generations: 50,
                gate: "total_net_profit > 0 AND max_drawdown_percent < 15 AND positive_windows_rate >= 50%",
            },
            stageC: {
                seeds: stageCSeeds,
                gate: "all_3_stage_b_runs_pass",
            },
            stageD: {
                symbol: options.secondarySymbol,
                gate: "max_drawdown_percent < 30",
            },
            backtest: {
                initialCapital: options.initialCapital,
                positionSize: options.positionSize,
                commission: options.commission,
                sizingMode: options.sizingMode,
                fixedTradeAmount: options.fixedTradeAmount,
                executionModel: options.executionModel,
                tradeFilterMode: options.tradeFilterMode,
                slippageBps: options.slippageBps,
                allowSameBarExit: options.allowSameBarExit,
            },
        },
        stages: {
            stageA: {
                seed: stageASeed,
                pass: stageAPass,
                reasons: stageAReasons,
                outFile: stageAOut,
                trainNetProfitPercent: stageATrainNet,
                report: stageAReport,
            },
            stageB: {
                seed: stageBSeed,
                pass: stageBGate.pass,
                reasons: stageBGate.reasons,
                outFile: stageBOut,
                derivedMaxDrawdownPercent: stageBDerivedDdPercent,
                report: stageBReport,
            },
            stageC: {
                pass: stageCPass,
                reasons: stageCReasons,
                runs: stageCRuns,
            },
            stageD: {
                seed: stageDSeed,
                pass: stageDGate.pass,
                reasons: stageDGate.reasons,
                outFile: stageDOut,
                derivedMaxDrawdownPercent: stageDDerivedDdPercent,
                report: stageDReport,
            },
        },
        finalDecision: {
            pass: finalPass,
            decision: finalPass ? "PASS" : "FAIL",
        },
    };

    fs.writeFileSync(options.outFile, JSON.stringify(report, null, 2), "utf8");
    console.log(`[QualityHunt] Final=${report.finalDecision.decision}`);
    console.log(`[QualityHunt] Wrote: ${options.outFile}`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runQualityHunt(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`quality-hunt failed: ${message}`);
        process.exitCode = 1;
    });
}
