import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadEnv } from "vite";
import type {
    LiveExecutorStatus,
    LiveTradeOrderType,
    LiveTradeSizingMode,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
} from "./execution-lab-model";
import {
    LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_ORDER_TYPE,
    buildLiveTradeFailureResponse,
    normalizeLiveTradeSubmitResponse,
} from "./live-trade-request";

const DEFAULT_MAX_STAKE_USD = 100;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_STDOUT_BYTE_LIMIT = 64 * 1024;
const DEFAULT_STDERR_BYTE_LIMIT = 64 * 1024;
const SUPPORTED_ORDER_TYPES: LiveTradeOrderType[] = ["FOK", "FAK"];
const DEFAULT_ENV_MODE = "development";
const SAFE_PARENT_ENV_KEYS = [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "Path",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
] as const;

export interface LiveExecutorAdapterConfig {
    executorPath: string;
    executorCwd: string;
    executorArgs: string[];
    liveEnabled: boolean;
    maxStakeUsd: number;
    sizingMode: LiveTradeSizingMode;
    orderType: LiveTradeOrderType;
    timeoutMs: number;
    stdoutByteLimit: number;
    stderrByteLimit: number;
    geoblockAllowed: boolean | null;
    entryMaxSlippageCents: number;
    exitMaxSlippageCents: number;
}

function parseBool(value: string | undefined): boolean {
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function parseBoolOrNull(value: string | undefined): boolean | null {
    if (value === undefined || value.trim() === "") return null;
    return parseBool(value);
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseSizingMode(value: string | undefined): LiveTradeSizingMode {
    const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
    return normalized === "exchange_min" ? "exchange_min" : "fixed";
}

function parseOrderType(value: string | undefined): LiveTradeOrderType {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized === "FOK" || normalized === "FAK" ? normalized : LIVE_TRADE_DEFAULT_ORDER_TYPE;
}

function parseArgsJson(value: string | undefined): string[] {
    if (!value || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
        return [];
    }
}

function inferExecutorCwd(executorPath: string, configuredCwd: string | undefined): string {
    const trimmedCwd = String(configuredCwd ?? "").trim();
    if (trimmedCwd) return resolve(trimmedCwd);

    const trimmedPath = executorPath.trim();
    if (!trimmedPath) return process.cwd();

    const binaryDir = dirname(trimmedPath);
    const profileDir = basename(binaryDir).toLowerCase();
    const targetDir = basename(dirname(binaryDir)).toLowerCase();
    return targetDir === "target" && (profileDir === "debug" || profileDir === "release")
        ? dirname(dirname(binaryDir))
        : process.cwd();
}

function readRepoEnv(env: NodeJS.ProcessEnv, envDir = process.cwd()): NodeJS.ProcessEnv {
    const mode = String(env.MODE || env.NODE_ENV || DEFAULT_ENV_MODE);
    return { ...loadEnv(mode, envDir, ""), ...env };
}

function buildExecutorEnv(config: LiveExecutorAdapterConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_PARENT_ENV_KEYS) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.LIVE_TRADE_ONCE_LIVE_ENABLED = config.liveEnabled ? "1" : "0";
    env.EXECUTION_LAB_LIVE_SIZING_MODE = config.sizingMode;
    env.EXECUTION_LAB_LIVE_ORDER_TYPE = config.orderType;
    env.ARBITRAGE_ORDER_TYPE = config.orderType;
    env.DRY_RUN = config.liveEnabled ? "false" : "true";
    return env;
}

export function readLiveExecutorConfig(
    env: NodeJS.ProcessEnv = process.env,
    override?: Partial<LiveExecutorAdapterConfig>,
    envDir?: string
): LiveExecutorAdapterConfig {
    const mergedEnv = readRepoEnv(env, envDir);
    const executorPath = override?.executorPath ?? String(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_PATH ?? "").trim();
    return {
        executorPath,
        executorCwd: override?.executorCwd ?? inferExecutorCwd(executorPath, mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_CWD),
        executorArgs: override?.executorArgs ?? parseArgsJson(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON),
        liveEnabled: override?.liveEnabled ?? parseBool(mergedEnv.EXECUTION_LAB_LIVE_ENABLED),
        maxStakeUsd: override?.maxStakeUsd ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_MAX_STAKE_USD, DEFAULT_MAX_STAKE_USD),
        sizingMode: override?.sizingMode ?? parseSizingMode(mergedEnv.EXECUTION_LAB_LIVE_SIZING_MODE),
        orderType: override?.orderType ?? parseOrderType(mergedEnv.EXECUTION_LAB_LIVE_ORDER_TYPE ?? mergedEnv.ARBITRAGE_ORDER_TYPE),
        entryMaxSlippageCents: override?.entryMaxSlippageCents ?? parseNonNegativeNumber(
            mergedEnv.EXECUTION_LAB_LIVE_ENTRY_MAX_SLIPPAGE_CENTS,
            LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS
        ),
        exitMaxSlippageCents: override?.exitMaxSlippageCents ?? parseNonNegativeNumber(
            mergedEnv.EXECUTION_LAB_LIVE_EXIT_MAX_SLIPPAGE_CENTS,
            LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS
        ),
        timeoutMs: override?.timeoutMs ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        stdoutByteLimit: override?.stdoutByteLimit ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_STDOUT_LIMIT_BYTES, DEFAULT_STDOUT_BYTE_LIMIT),
        stderrByteLimit: override?.stderrByteLimit ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_STDERR_LIMIT_BYTES, DEFAULT_STDERR_BYTE_LIMIT),
        geoblockAllowed: override?.geoblockAllowed ?? parseBoolOrNull(mergedEnv.EXECUTION_LAB_LIVE_GEOBLOCK_ALLOWED),
    };
}

export function loadLiveExecutorStatus(configOverride?: Partial<LiveExecutorAdapterConfig>): LiveExecutorStatus {
    const config = readLiveExecutorConfig(process.env, configOverride);
    const configured = config.executorPath.length > 0;
    const executorExists = configured && existsSync(config.executorPath);
    const cwdExists = existsSync(config.executorCwd);
    const available = executorExists && cwdExists;
    const message = !configured
        ? "Executor path not configured."
        : !executorExists
            ? "Executor path does not exist."
            : !cwdExists
                ? "Executor working directory does not exist."
                : (config.liveEnabled ? "Executor configured for live submission." : "Executor configured for dry-run submission.");
    return {
        ok: true,
        configured,
        available,
        liveEnabled: config.liveEnabled,
        dryRun: !config.liveEnabled,
        executorKind: "cli",
        geoblockAllowed: config.geoblockAllowed,
        maxStakeUsd: config.maxStakeUsd,
        sizingMode: config.sizingMode,
        orderType: config.orderType,
        entryMaxSlippageCents: config.entryMaxSlippageCents,
        exitMaxSlippageCents: config.exitMaxSlippageCents,
        supportedOrderTypes: SUPPORTED_ORDER_TYPES,
        message,
    };
}

export async function submitLiveTradeToExecutor(
    request: LiveTradeSubmitRequest,
    configOverride?: Partial<LiveExecutorAdapterConfig>
): Promise<LiveTradeSubmitResponse> {
    const config = readLiveExecutorConfig(process.env, configOverride);
    if (!config.executorPath || !existsSync(config.executorPath)) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            reason: "executor_unavailable",
            maxPrice: request.maxPrice,
            minPrice: request.action === "exit" ? request.minPrice : undefined,
        });
    }

    if (request.orderType !== config.orderType) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            status: "rejected",
            reason: "order_type_config_mismatch",
            maxPrice: request.maxPrice,
            minPrice: request.action === "exit" ? request.minPrice : undefined,
        });
    }

    if (request.action === "entry" && config.sizingMode !== "exchange_min" && request.stakeUsd > config.maxStakeUsd) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            status: "rejected",
            reason: "stake_above_executor_cap",
            maxPrice: request.maxPrice,
        });
    }

    return await new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let outputLimitExceeded: "stdout" | "stderr" | null = null;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks: Buffer[] = [];
        const child = spawn(config.executorPath, config.executorArgs, {
            cwd: config.executorCwd,
            windowsHide: true,
            env: buildExecutorEnv(config),
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, config.timeoutMs);

        function finish(response: LiveTradeSubmitResponse): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(response);
        }

        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > config.stdoutByteLimit) {
                outputLimitExceeded = "stdout";
                child.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > config.stderrByteLimit) {
                outputLimitExceeded = "stderr";
                child.kill();
            }
        });

        child.on("error", () => {
            finish(buildLiveTradeFailureResponse({
                requestId: request.requestId,
                reason: "executor_unavailable",
                maxPrice: request.maxPrice,
                minPrice: request.action === "exit" ? request.minPrice : undefined,
            }));
        });

        child.on("close", () => {
            if (timedOut) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_timeout",
                    maxPrice: request.maxPrice,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                }));
                return;
            }
            if (outputLimitExceeded) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    maxPrice: request.maxPrice,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                }));
                return;
            }

            const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
            if (!stdout) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    maxPrice: request.maxPrice,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                }));
                return;
            }

            try {
                const parsed = JSON.parse(stdout) as unknown;
                const normalized = normalizeLiveTradeSubmitResponse(parsed, request.requestId);
                finish(normalized.ok
                    ? normalized.response
                    : buildLiveTradeFailureResponse({
                        requestId: request.requestId,
                        reason: "executor_invalid_stdout",
                        maxPrice: request.maxPrice,
                        minPrice: request.action === "exit" ? request.minPrice : undefined,
                    }));
            } catch {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    maxPrice: request.maxPrice,
                    minPrice: request.action === "exit" ? request.minPrice : undefined,
                }));
            }
        });

        child.stdin.end(JSON.stringify(request), "utf8");
    });
}
