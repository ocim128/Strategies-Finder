import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadEnv } from "vite";
import type {
    ExecutionLabLiveUiConfig,
    LiveExecutorStatus,
    LiveCancelAllSubmitRequest,
    LiveCancelAllSubmitResponse,
    LiveCancelScope,
    LiveLimitOrderType,
    LiveOrderMode,
    LiveTakerOrderType,
    LiveTradeSizingMode,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
} from "./execution-lab-model";
import {
    EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG,
    LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
    LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
    LIVE_TRADE_DEFAULT_LIMIT_OFFSET_CENTS,
    LIVE_TRADE_DEFAULT_LIMIT_OFFSET_ENABLED,
    LIVE_TRADE_DEFAULT_MAX_STAKE_USD,
    LIVE_TRADE_DEFAULT_ORDER_TYPE,
    buildLiveCancelAllFailureResponse,
    buildLiveTradeFailureResponse,
    isLiveCancelScope,
    isLiveOrderMode,
    isLiveTakerOrderType,
    normalizeExecutionLabLiveUiConfig,
    normalizeLiveCancelAllSubmitResponse,
    normalizeLiveTradeSubmitResponse,
} from "./live-trade-request";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_STDOUT_BYTE_LIMIT = 64 * 1024;
const DEFAULT_STDERR_BYTE_LIMIT = 64 * 1024;
const SUPPORTED_TAKER_ORDER_TYPES: LiveTakerOrderType[] = ["FOK", "FAK"];
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
    executorUrl: string;
    executorCwd: string;
    executorArgs: string[];
    liveEnabled: boolean;
    maxStakeUsd: number;
    sizingMode: LiveTradeSizingMode;
    orderMode: LiveOrderMode;
    takerOrderType: LiveTakerOrderType;
    orderType: LiveTakerOrderType;
    limitOrderType: LiveLimitOrderType;
    timeoutMs: number;
    stdoutByteLimit: number;
    stderrByteLimit: number;
    geoblockAllowed: boolean | null;
    entryMaxSlippageCents: number;
    exitMaxSlippageCents: number;
    limitOffsetEnabled: boolean;
    limitOffsetCents: number;
    limitFixedPriceEnabled: boolean;
    limitFixedPriceCents: number;
    limitCancelAllOnExitEnabled: boolean;
    cancelScope: LiveCancelScope;
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

function parseOrderMode(value: string | undefined): LiveOrderMode {
    const normalized = String(value ?? "").trim().toLowerCase();
    return isLiveOrderMode(normalized) ? normalized : "taker";
}

function parseTakerOrderType(value: string | undefined): LiveTakerOrderType {
    const normalized = String(value ?? "").trim().toUpperCase();
    return isLiveTakerOrderType(normalized) ? normalized : LIVE_TRADE_DEFAULT_ORDER_TYPE;
}

function parseLimitOrderType(value: string | undefined): LiveLimitOrderType {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized === "GTC" ? "GTC" : LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE;
}

function parseCancelScope(value: string | undefined): LiveCancelScope {
    const raw = String(value ?? "").trim();
    if (!raw) return "session";
    const normalized = raw.toLowerCase();
    return isLiveCancelScope(normalized) ? normalized : "unknown";
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

function parseExecutorUrl(value: string | undefined): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    try {
        const url = new URL(trimmed);
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
        return "";
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

function effectiveExecutorOrderType(
    request: LiveTradeSubmitRequest | LiveCancelAllSubmitRequest,
    config: LiveExecutorAdapterConfig
): string {
    if (request.action === "cancel_all") return config.limitOrderType;
    if (request.action === "take_profit" || (request.action === "entry" && request.orderMode === "limit")) {
        return config.limitOrderType;
    }
    return config.takerOrderType;
}

function buildExecutorEnv(
    config: LiveExecutorAdapterConfig,
    request: LiveTradeSubmitRequest | LiveCancelAllSubmitRequest
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_PARENT_ENV_KEYS) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const orderType = effectiveExecutorOrderType(request, config);
    env.LIVE_TRADE_ONCE_LIVE_ENABLED = config.liveEnabled ? "1" : "0";
    env.EXECUTION_LAB_LIVE_SIZING_MODE = config.sizingMode;
    env.EXECUTION_LAB_LIVE_ORDER_MODE = request.action === "cancel_all" ? "limit" : request.orderMode;
    env.EXECUTION_LAB_LIVE_TAKER_ORDER_TYPE = config.takerOrderType;
    env.EXECUTION_LAB_LIVE_LIMIT_ORDER_TYPE = config.limitOrderType;
    env.EXECUTION_LAB_LIVE_ORDER_TYPE = orderType;
    env.EXECUTION_LAB_LIVE_CANCEL_SCOPE = request.action === "cancel_all" ? request.scope : config.cancelScope;
    env.ARBITRAGE_ORDER_TYPE = orderType;
    env.DRY_RUN = config.liveEnabled ? "false" : "true";
    return env;
}

function buildExecutorTradeRequest(
    request: LiveTradeSubmitRequest,
    config: LiveExecutorAdapterConfig
): LiveTradeSubmitRequest & { sizingMode?: LiveTradeSizingMode } {
    if (request.action !== "entry") return request;
    return {
        ...request,
        sizingMode: config.sizingMode,
    };
}

export function readLiveExecutorConfig(
    env: NodeJS.ProcessEnv = process.env,
    override?: Partial<LiveExecutorAdapterConfig>,
    envDir?: string
): LiveExecutorAdapterConfig {
    const mergedEnv = readRepoEnv(env, envDir);
    const executorPath = override?.executorPath ?? String(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_PATH ?? "").trim();
    const executorUrl = override?.executorUrl ?? parseExecutorUrl(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_URL);
    const takerOrderType = override?.takerOrderType
        ?? override?.orderType
        ?? parseTakerOrderType(
            mergedEnv.EXECUTION_LAB_LIVE_TAKER_ORDER_TYPE
            ?? mergedEnv.EXECUTION_LAB_LIVE_ORDER_TYPE
            ?? mergedEnv.ARBITRAGE_ORDER_TYPE
        );
    return {
        executorPath,
        executorUrl,
        executorCwd: override?.executorCwd ?? inferExecutorCwd(executorPath, mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_CWD),
        executorArgs: override?.executorArgs ?? parseArgsJson(mergedEnv.EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON),
        liveEnabled: override?.liveEnabled ?? parseBool(mergedEnv.EXECUTION_LAB_LIVE_ENABLED),
        maxStakeUsd: override?.maxStakeUsd ?? parsePositiveNumber(mergedEnv.EXECUTION_LAB_LIVE_MAX_STAKE_USD, LIVE_TRADE_DEFAULT_MAX_STAKE_USD),
        sizingMode: override?.sizingMode ?? parseSizingMode(mergedEnv.EXECUTION_LAB_LIVE_SIZING_MODE),
        orderMode: override?.orderMode ?? parseOrderMode(mergedEnv.EXECUTION_LAB_LIVE_ORDER_MODE),
        takerOrderType,
        orderType: takerOrderType,
        limitOrderType: override?.limitOrderType ?? parseLimitOrderType(mergedEnv.EXECUTION_LAB_LIVE_LIMIT_ORDER_TYPE),
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
        limitOffsetEnabled: override?.limitOffsetEnabled ?? LIVE_TRADE_DEFAULT_LIMIT_OFFSET_ENABLED,
        limitOffsetCents: override?.limitOffsetCents ?? LIVE_TRADE_DEFAULT_LIMIT_OFFSET_CENTS,
        limitFixedPriceEnabled: override?.limitFixedPriceEnabled ?? EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG.limitFixedPriceEnabled,
        limitFixedPriceCents: override?.limitFixedPriceCents ?? EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG.limitFixedPriceCents,
        limitCancelAllOnExitEnabled: override?.limitCancelAllOnExitEnabled ?? false,
        cancelScope: override?.cancelScope ?? parseCancelScope(mergedEnv.EXECUTION_LAB_LIVE_CANCEL_SCOPE),
    };
}

export function resolveLiveExecutorConfig(
    liveUiConfig?: ExecutionLabLiveUiConfig,
    configOverride?: Partial<LiveExecutorAdapterConfig>
): LiveExecutorAdapterConfig {
    const base = readLiveExecutorConfig(process.env, configOverride);
    if (!liveUiConfig) return base;
    const uiConfig = normalizeExecutionLabLiveUiConfig(liveUiConfig, {
        ...EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG,
        orderMode: base.orderMode,
        takerOrderType: base.takerOrderType,
        sizingMode: base.sizingMode,
        maxStakeUsd: base.maxStakeUsd,
        entryMaxSlippageCents: base.entryMaxSlippageCents,
        exitMaxSlippageCents: base.exitMaxSlippageCents,
        limitOffsetEnabled: base.limitOffsetEnabled,
        limitOffsetCents: base.limitOffsetCents,
        limitFixedPriceEnabled: base.limitFixedPriceEnabled,
        limitFixedPriceCents: base.limitFixedPriceCents,
        limitCancelAllOnExitEnabled: base.limitCancelAllOnExitEnabled,
    });
    return {
        ...base,
        orderMode: uiConfig.orderMode,
        takerOrderType: uiConfig.takerOrderType,
        orderType: uiConfig.takerOrderType,
        sizingMode: uiConfig.sizingMode,
        maxStakeUsd: uiConfig.maxStakeUsd,
        entryMaxSlippageCents: uiConfig.entryMaxSlippageCents,
        exitMaxSlippageCents: uiConfig.exitMaxSlippageCents,
        limitOffsetEnabled: uiConfig.limitOffsetEnabled,
        limitOffsetCents: uiConfig.limitOffsetCents,
        limitFixedPriceEnabled: uiConfig.limitFixedPriceEnabled,
        limitFixedPriceCents: uiConfig.limitFixedPriceCents,
        limitCancelAllOnExitEnabled: uiConfig.limitCancelAllOnExitEnabled,
    };
}

export function loadLiveExecutorStatus(
    configOverride?: Partial<LiveExecutorAdapterConfig>,
    liveUiConfig?: ExecutionLabLiveUiConfig
): LiveExecutorStatus {
    const config = resolveLiveExecutorConfig(liveUiConfig, configOverride);
    const configured = config.executorUrl.length > 0 || config.executorPath.length > 0;
    const usesHttpExecutor = config.executorUrl.length > 0;
    const executorExists = configured && existsSync(config.executorPath);
    const cwdExists = existsSync(config.executorCwd);
    const available = usesHttpExecutor || (executorExists && cwdExists);
    const message = !configured
        ? "Executor path not configured."
        : usesHttpExecutor
            ? (config.liveEnabled ? "HTTP executor configured for live submission." : "HTTP executor configured for dry-run submission.")
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
        executorKind: usesHttpExecutor ? "http" : "cli",
        geoblockAllowed: config.geoblockAllowed,
        maxStakeUsd: config.maxStakeUsd,
        sizingMode: config.sizingMode,
        orderMode: config.orderMode,
        takerOrderType: config.takerOrderType,
        orderType: config.takerOrderType,
        limitOffsetEnabled: config.limitOffsetEnabled,
        limitOffsetCents: config.limitOffsetCents,
        limitFixedPriceEnabled: config.limitFixedPriceEnabled,
        limitFixedPriceCents: config.limitFixedPriceCents,
        limitCancelAllOnExitEnabled: config.limitCancelAllOnExitEnabled,
        entryMaxSlippageCents: config.entryMaxSlippageCents,
        exitMaxSlippageCents: config.exitMaxSlippageCents,
        supportedOrderTypes: SUPPORTED_TAKER_ORDER_TYPES,
        supportedTakerOrderTypes: SUPPORTED_TAKER_ORDER_TYPES,
        supportedLimitOrderType: config.limitOrderType,
        cancelScope: config.cancelScope,
        message,
    };
}

async function postExecutorJson(args: {
    url: string;
    body: LiveTradeSubmitRequest | LiveCancelAllSubmitRequest;
    timeoutMs: number;
    byteLimit: number;
}): Promise<{ ok: true; payload: unknown } | { ok: false; reason: "executor_timeout" | "executor_unavailable" | "executor_invalid_stdout" }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
        const response = await fetch(args.url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(args.body),
            signal: controller.signal,
        });
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > args.byteLimit) {
            return { ok: false, reason: "executor_invalid_stdout" };
        }
        if (!response.ok) {
            return { ok: false, reason: "executor_unavailable" };
        }
        try {
            return { ok: true, payload: JSON.parse(text) as unknown };
        } catch {
            return { ok: false, reason: "executor_invalid_stdout" };
        }
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error && error.name === "AbortError"
                ? "executor_timeout"
                : "executor_unavailable",
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function submitLiveTradeToExecutor(
    request: LiveTradeSubmitRequest,
    configOverride?: Partial<LiveExecutorAdapterConfig>,
    liveUiConfig?: ExecutionLabLiveUiConfig
): Promise<LiveTradeSubmitResponse> {
    const config = resolveLiveExecutorConfig(liveUiConfig, configOverride);
    const failurePriceFields = {
        maxPrice: request.maxPrice,
        limitPrice: request.orderMode === "limit" ? request.limitPrice : undefined,
        minPrice: request.action === "exit" || request.action === "take_profit" ? request.minPrice : undefined,
    };
    const expectedOrderMode = request.action === "exit"
        ? "taker"
        : request.action === "take_profit"
            ? "limit"
            : config.orderMode;
    const expectedOrderType = request.action === "take_profit" || (request.action === "entry" && request.orderMode === "limit")
        ? config.limitOrderType
        : config.takerOrderType;
    if (request.orderMode !== expectedOrderMode) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            status: "rejected",
            reason: "order_mode_config_mismatch",
            ...failurePriceFields,
        });
    }
    if (request.orderType !== expectedOrderType) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            status: "rejected",
            reason: "order_type_config_mismatch",
            ...failurePriceFields,
        });
    }

    if (request.action === "entry" && config.sizingMode !== "exchange_min" && request.stakeUsd > config.maxStakeUsd) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            status: "rejected",
            reason: "stake_above_executor_cap",
            ...failurePriceFields,
        });
    }

    if (config.executorUrl) {
        const executorRequest = buildExecutorTradeRequest(request, config);
        const result = await postExecutorJson({
            url: config.executorUrl,
            body: executorRequest,
            timeoutMs: config.timeoutMs,
            byteLimit: config.stdoutByteLimit,
        });
        if (!result.ok) {
            return buildLiveTradeFailureResponse({
                requestId: request.requestId,
                reason: result.reason,
                ...failurePriceFields,
            });
        }
        const normalized = normalizeLiveTradeSubmitResponse(result.payload, request.requestId);
        return normalized.ok
            ? normalized.response
            : buildLiveTradeFailureResponse({
                requestId: request.requestId,
                reason: "executor_invalid_stdout",
                ...failurePriceFields,
            });
    }

    if (!config.executorPath || !existsSync(config.executorPath)) {
        return buildLiveTradeFailureResponse({
            requestId: request.requestId,
            reason: "executor_unavailable",
            ...failurePriceFields,
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
            env: buildExecutorEnv(config, request),
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
                ...failurePriceFields,
            }));
        });

        child.on("close", () => {
            if (timedOut) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_timeout",
                    ...failurePriceFields,
                }));
                return;
            }
            if (outputLimitExceeded) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    ...failurePriceFields,
                }));
                return;
            }

            const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
            if (!stdout) {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    ...failurePriceFields,
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
                        ...failurePriceFields,
                    }));
            } catch {
                finish(buildLiveTradeFailureResponse({
                    requestId: request.requestId,
                    reason: "executor_invalid_stdout",
                    ...failurePriceFields,
                }));
            }
        });

        child.stdin.end(JSON.stringify(buildExecutorTradeRequest(request, config)), "utf8");
    });
}

export async function submitLiveCancelAllToExecutor(
    request: LiveCancelAllSubmitRequest,
    configOverride?: Partial<LiveExecutorAdapterConfig>,
    liveUiConfig?: ExecutionLabLiveUiConfig
): Promise<LiveCancelAllSubmitResponse> {
    const config = resolveLiveExecutorConfig(liveUiConfig, configOverride);
    if (config.orderMode !== "limit") {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            status: "rejected",
            reason: "order_mode_config_mismatch",
        });
    }
    const isTargetedSessionCancel = request.scope === "session"
        && request.orderIds !== undefined
        && request.orderIds.length > 0;
    if (!config.limitCancelAllOnExitEnabled && !isTargetedSessionCancel) {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            status: "rejected",
            reason: "limit_cancel_all_disabled",
        });
    }
    if ((request.scope === "unknown" || config.cancelScope === "unknown") && !isTargetedSessionCancel) {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            status: "rejected",
            reason: "cancel_scope_unconfigured",
        });
    }
    if (request.scope === "session" && (!request.orderIds || request.orderIds.length === 0)) {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            status: "rejected",
            reason: "session_cancel_missing_order_ids",
        });
    }
    if (request.scope !== config.cancelScope && !isTargetedSessionCancel) {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            status: "rejected",
            reason: "cancel_scope_config_mismatch",
        });
    }

    if (config.executorUrl) {
        const result = await postExecutorJson({
            url: config.executorUrl,
            body: request,
            timeoutMs: config.timeoutMs,
            byteLimit: config.stdoutByteLimit,
        });
        if (!result.ok) {
            return buildLiveCancelAllFailureResponse({
                requestId: request.requestId,
                scope: request.scope,
                reason: result.reason,
            });
        }
        const normalized = normalizeLiveCancelAllSubmitResponse(result.payload, request.requestId);
        return normalized.ok
            ? normalized.response
            : buildLiveCancelAllFailureResponse({
                requestId: request.requestId,
                scope: request.scope,
                reason: "executor_invalid_stdout",
            });
    }

    if (!config.executorPath || !existsSync(config.executorPath)) {
        return buildLiveCancelAllFailureResponse({
            requestId: request.requestId,
            scope: request.scope,
            reason: "executor_unavailable",
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
            env: buildExecutorEnv(config, request),
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, config.timeoutMs);

        function finish(response: LiveCancelAllSubmitResponse): void {
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
            finish(buildLiveCancelAllFailureResponse({
                requestId: request.requestId,
                scope: request.scope,
                reason: "executor_unavailable",
            }));
        });

        child.on("close", () => {
            if (timedOut) {
                finish(buildLiveCancelAllFailureResponse({
                    requestId: request.requestId,
                    scope: request.scope,
                    reason: "executor_timeout",
                }));
                return;
            }
            if (outputLimitExceeded) {
                finish(buildLiveCancelAllFailureResponse({
                    requestId: request.requestId,
                    scope: request.scope,
                    reason: "executor_invalid_stdout",
                }));
                return;
            }

            const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
            if (!stdout) {
                finish(buildLiveCancelAllFailureResponse({
                    requestId: request.requestId,
                    scope: request.scope,
                    reason: "executor_invalid_stdout",
                }));
                return;
            }

            try {
                const parsed = JSON.parse(stdout) as unknown;
                const normalized = normalizeLiveCancelAllSubmitResponse(parsed, request.requestId);
                finish(normalized.ok
                    ? normalized.response
                    : buildLiveCancelAllFailureResponse({
                        requestId: request.requestId,
                        scope: request.scope,
                        reason: "executor_invalid_stdout",
                    }));
            } catch {
                finish(buildLiveCancelAllFailureResponse({
                    requestId: request.requestId,
                    scope: request.scope,
                    reason: "executor_invalid_stdout",
                }));
            }
        });

        child.stdin.end(JSON.stringify(request), "utf8");
    });
}
