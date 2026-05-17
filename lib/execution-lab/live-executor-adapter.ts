import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnv } from "vite";
import type { LiveTradeOrderType, LiveTradeSizingMode, LiveTradeSubmitRequest, LiveTradeSubmitResponse } from "./execution-lab-model";
import {
    LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
    buildLiveTradeFailureResponse,
    normalizeLiveTradeSubmitResponse,
} from "./live-trade-request";

const DEFAULT_MAX_STAKE_USD = 100;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_STDOUT_BYTE_LIMIT = 64 * 1024;
const DEFAULT_STDERR_BYTE_LIMIT = 64 * 1024;
const SUPPORTED_ORDER_TYPES: LiveTradeOrderType[] = ["FOK", "FAK"];
const DEFAULT_ENV_MODE = "development";

export interface LiveExecutorStatus {
    ok: true;
    configured: boolean;
    available: boolean;
    liveEnabled: boolean;
    dryRun: boolean;
    executorKind: "cli";
    geoblockAllowed: boolean | null;
    maxStakeUsd: number;
    sizingMode: LiveTradeSizingMode;
    exitMaxSlippageCents: number;
    supportedOrderTypes: LiveTradeOrderType[];
    message: string;
    executorPath?: string;
}

export interface LiveExecutorAdapterConfig {
    executorPath: string;
    executorArgs: string[];
    liveEnabled: boolean;
    maxStakeUsd: number;
    sizingMode: LiveTradeSizingMode;
    timeoutMs: number;
    stdoutByteLimit: number;
    stderrByteLimit: number;
    geoblockAllowed: boolean | null;
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

function parseArgsJson(value: string | undefined): string[] {
    if (!value || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
        return [];
    }
}

function readRepoEnv(env: NodeJS.ProcessEnv, envDir = process.cwd()): NodeJS.ProcessEnv {
    const mode = String(env.MODE || env.NODE_ENV || DEFAULT_ENV_MODE);
    return { ...loadEnv(mode, envDir, ""), ...env };
}

export function readLiveExecutorConfig(
    env: NodeJS.ProcessEnv = process.env,
    override?: Partial<LiveExecutorAdapterConfig>,
    envDir?: string
): LiveExecutorAdapterConfig {
    const mergedEnv = readRepoEnv(env, envDir);
    return {
        executorPath: override?.executorPath ?? String(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_PATH ?? "").trim(),
        executorArgs: override?.executorArgs ?? parseArgsJson(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON),
        liveEnabled: override?.liveEnabled ?? parseBool(mergedEnv.EXECUTION_LAB_LIVE_ENABLED),
        maxStakeUsd: override?.maxStakeUsd ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_MAX_STAKE_USD, DEFAULT_MAX_STAKE_USD),
        sizingMode: override?.sizingMode ?? parseSizingMode(mergedEnv.EXECUTION_LAB_LIVE_SIZING_MODE),
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
    const available = configured && existsSync(config.executorPath);
    const message = !configured
        ? "Executor path not configured."
        : available
            ? (config.liveEnabled ? "Executor configured for live submission." : "Executor configured for dry-run submission.")
            : "Executor path does not exist.";
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
        exitMaxSlippageCents: config.exitMaxSlippageCents,
        supportedOrderTypes: SUPPORTED_ORDER_TYPES,
        message,
        ...(configured ? { executorPath: config.executorPath } : {}),
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
            cwd: process.cwd(),
            windowsHide: true,
            env: {
                ...readRepoEnv(process.env),
                LIVE_TRADE_ONCE_LIVE_ENABLED: config.liveEnabled ? "1" : "0",
                EXECUTION_LAB_LIVE_SIZING_MODE: config.sizingMode,
                DRY_RUN: config.liveEnabled ? "false" : "true",
            },
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
