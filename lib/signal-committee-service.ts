/**
 * Signal Committee service.
 *
 * Owns:
 * - the in-memory member cache (worker subscriptions tagged committee_tag)
 * - the refresh loop (manual + auto, visibility-aware)
 * - Add / Load / Remove orchestration
 *
 * Talks only to alertService, settingsManager, state, uiManager, and the
 * pure renderer/score modules. Never touches the chart directly.
 */
import { ensureLazyStylesheet } from "./lazy-styles";
import {
    alertService,
    buildAlertStreamId,
    parseAlertConfigNameFromStreamId,
    type AlertSubscription,
    type CommitteeMemberState,
} from "./alert-service";
import { isWorkerSupportedStrategyKey } from "./alert-subscription-utils";
import { deriveSyntheticSymbol } from "../scripts/lib/synthetic-pair";
import { dataMiningManager } from "./data-mining-manager";
import { settingsManager } from "./settings-manager";
import { state } from "./state";
import { chartManager } from "./chart-manager";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import { evaluateLatestEntrySignal } from "./signal-entry-evaluator";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import { resolveCurrentAlertSubscriptionContext } from "./current-alert-subscription";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import {
    aggregateScore,
    gainPctForRow,
    formatAgeShort,
    formatPercentSigned,
    ageSecForRow,
    type CommitteeAggregate,
    type CommitteeScoreRow,
} from "./signal-committee-score";
import {
    computeCommitteeOverlayScores,
    toOverlayPoints,
} from "./signal-committee-overlay";
import {
    renderCommitteeHeader,
    renderCommitteeRows,
    renderEmptyHealthFail,
    type CommitteeRowView,
} from "./signal-committee-renderer";
import { createSignalCommitteeDom, type SignalCommitteeDom } from "./signal-committee-dom";
import {
    readSignalCommitteePrefs,
    writeSignalCommitteePrefs,
    type SignalCommitteePrefs,
} from "./signal-committee-prefs";
import type { StrategyConfig } from "./settings-model";
import type { BacktestSettings } from "./types/strategies";

const HEALTH_STALE_RUN_AT_SEC = 600; // 10 minutes since last_run_at = stale cron

const DEFAULT_COMMITTEE_TAG = "default";
const LOCAL_SYNTHETIC_COMMITTEE_TAG = "local_synthetic";
const LOCAL_SYNTHETIC_STREAM_PREFIX = "local-synthetic:";
const MEMBER_HARD_CAP = 25;
const LOCAL_SYNTHETIC_MEMBERS_STORAGE = {
    key: "signal_committee_local_synthetic_members",
    schema: "signal_committee_local_synthetic_members",
    version: 1,
} as const;

interface LocalSyntheticCommitteeMember {
    streamId: string;
    configName: string;
    createdAt: string;
    updatedAt: string;
}

interface LocalSyntheticMemberRecord {
    stored: LocalSyntheticCommitteeMember;
    config: StrategyConfig | null;
    subscription: AlertSubscription;
    syntheticPair: { baseSymbol: string; quoteSymbol: string } | null;
    interval: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: Record<string, unknown>;
}

function isLocalSyntheticStreamId(streamId: string): boolean {
    return streamId.startsWith(LOCAL_SYNTHETIC_STREAM_PREFIX);
}

function buildLocalSyntheticStreamId(
    symbol: string,
    interval: string,
    strategyKey: string,
    configName: string
): string {
    return `${LOCAL_SYNTHETIC_STREAM_PREFIX}${buildAlertStreamId(symbol, interval, strategyKey, configName)}`;
}

function matchesSyntheticSymbol(
    symbol: string,
    known: { baseSymbol: string; quoteSymbol: string } | null
): boolean {
    if (!known) return false;
    const derived = deriveSyntheticSymbol(
        known.baseSymbol.trim().toUpperCase(),
        known.quoteSymbol.trim().toUpperCase()
    );
    const normalized = symbol.trim().toUpperCase();
    return normalized === derived || normalized.replace(/[^A-Z0-9]/g, "") === derived;
}

function parseJsonRecord(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function parseStrategyParamsJson(value: string): Record<string, number> {
    const parsed = parseJsonRecord(value);
    const params: Record<string, number> = {};
    for (const [key, raw] of Object.entries(parsed)) {
        const n = typeof raw === "number" ? raw : Number(raw);
        params[key] = Number.isFinite(n) ? n : 0;
    }
    return params;
}

function readLocalSyntheticMembers(): LocalSyntheticCommitteeMember[] {
    return readPersistedJson<LocalSyntheticCommitteeMember[]>({
        ...LOCAL_SYNTHETIC_MEMBERS_STORAGE,
        fallback: [],
        migrate: ({ data }) => {
            if (!Array.isArray(data)) return [];
            const members: LocalSyntheticCommitteeMember[] = [];
            const seen = new Set<string>();
            for (const item of data) {
                if (!item || typeof item !== "object") continue;
                const candidate = item as Partial<LocalSyntheticCommitteeMember>;
                if (
                    typeof candidate.streamId !== "string"
                    || typeof candidate.configName !== "string"
                    || !isLocalSyntheticStreamId(candidate.streamId)
                    || seen.has(candidate.streamId)
                ) {
                    continue;
                }
                const now = new Date().toISOString();
                seen.add(candidate.streamId);
                members.push({
                    streamId: candidate.streamId,
                    configName: candidate.configName,
                    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
                    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now,
                });
            }
            return members;
        },
    });
}

function writeLocalSyntheticMembers(members: readonly LocalSyntheticCommitteeMember[]): boolean {
    return writePersistedJson({
        ...LOCAL_SYNTHETIC_MEMBERS_STORAGE,
        data: members,
    });
}

class SignalCommitteeService {
    private dom: SignalCommitteeDom | null = null;
    private initialized = false;
    private members: AlertSubscription[] = [];
    private memberStates = new Map<string, CommitteeMemberState>();
    private latestStatesAtIso: string | null = null;
    private autoRefreshTimer: number | null = null;
    private refreshInFlight = false;
    private workerReachable = false;
    private prefs: SignalCommitteePrefs = { autoRefresh: false, intervalSec: 30 };

    /**
     * Last diagnostic snapshot — populated at every refresh, rendered into the
     * collapsible diagnostic <pre>. Lets the user (and us) see exactly which
     * stage broke: worker URL, health, list count, per-member raw state.
     */
    private lastDiagnostic: string = "";
    /**
     * Chart overlay mode:
     * - "off"        : no overlay
     * - "current"    : project the live committee score across all visible bars
     * - "historical" : per-bar net vote reconstructed from each member's
     *                  tradeWindows (entrySec..exitSec). Requires worker
     *                  support (latest_state_json.tradeWindows).
     */
    private overlayMode: "off" | "current" | "historical" = "off";

    private getDom(): SignalCommitteeDom {
        return this.dom ??= createSignalCommitteeDom();
    }

    public init(): void {
        if (this.initialized) return;
        ensureLazyStylesheet(
            "signal-committee-styles",
            new URL("../styles/signal-committee.css", import.meta.url).href
        );
        // Load persisted UI prefs before binding so the toggle reflects prior state.
        this.prefs = readSignalCommitteePrefs();
        const dom = this.getDom();
        dom.signalCommitteeAutoToggle.checked = this.prefs.autoRefresh;
        // Sync the select to the persisted interval, falling back to 30s if the
        // persisted value isn't one of the offered options.
        const intervalOptions = Array.from(dom.signalCommitteeIntervalSelect.options).map((o) => Number(o.value));
        if (intervalOptions.includes(this.prefs.intervalSec)) {
            dom.signalCommitteeIntervalSelect.value = String(this.prefs.intervalSec);
        } else {
            dom.signalCommitteeIntervalSelect.value = "30";
        }
        this.bindDomEvents(dom);
        if (this.prefs.autoRefresh) {
            this.startAutoRefresh();
        }
        this.initialized = true;
    }

    private bindDomEvents(dom: SignalCommitteeDom): void {
        dom.signalCommitteeRefreshBtn.addEventListener("click", () => {
            void this.refresh({ manual: true });
        });
        dom.signalCommitteeAddBtn.addEventListener("click", () => {
            void this.addCurrentConfiguration();
        });
        dom.signalCommitteeAutoToggle.addEventListener("change", () => {
            this.prefs = { ...this.prefs, autoRefresh: dom.signalCommitteeAutoToggle.checked };
            writeSignalCommitteePrefs(this.prefs);
            if (this.prefs.autoRefresh) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        });
        dom.signalCommitteeIntervalSelect.addEventListener("change", () => {
            const sec = Number(dom.signalCommitteeIntervalSelect.value);
            if (!Number.isFinite(sec) || sec <= 0) return;
            this.prefs = { ...this.prefs, intervalSec: sec };
            writeSignalCommitteePrefs(this.prefs);
            if (this.prefs.autoRefresh) {
                // Restart the timer so the new interval takes effect immediately.
                this.startAutoRefresh();
            }
        });
        dom.signalCommitteeChartToggleBtn.addEventListener("click", () => {
            // Cycle off -> current -> historical -> off.
            const next: "off" | "current" | "historical" =
                this.overlayMode === "off" ? "current"
                    : this.overlayMode === "current" ? "historical"
                        : "off";
            this.overlayMode = next;
            dom.signalCommitteeChartToggleBtn.textContent =
                next === "off" ? "Show Score on Chart"
                    : next === "current" ? "Score: Current (click for Historical)"
                        : "Score: Historical (click to hide)";
            if (next === "off") {
                chartManager.removeCommitteeScoreOverlay();
            } else {
                this.renderScoreOverlay();
            }
        });
        dom.signalCommitteeAlertSaveBtn.addEventListener("click", () => {
            void this.saveAlertRule();
        });
        dom.signalCommitteeTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const loadStream = target.dataset.signalCommitteeLoad;
            const removeStream = target.dataset.signalCommitteeRemove;
            if (loadStream) {
                void this.loadConfiguration(loadStream);
            } else if (removeStream) {
                void this.removeConfiguration(removeStream);
            }
        });

        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) {
                    this.stopAutoRefresh();
                } else if (dom.signalCommitteeAutoToggle.checked) {
                    this.startAutoRefresh();
                    void this.refresh({ manual: false });
                }
            });
        }
    }

    private startAutoRefresh(): void {
        this.stopAutoRefresh();
        const intervalMs = Math.max(10_000, this.prefs.intervalSec * 1000);
        this.autoRefreshTimer = window.setInterval(() => {
            void this.refresh({ manual: false });
        }, intervalMs);
    }

    private stopAutoRefresh(): void {
        if (this.autoRefreshTimer !== null) {
            window.clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
    }

    /**
     * Public so handlers can call it on tab-change. Re-checks worker health
     * because the user may have just configured the URL in the Alerts tab.
     */
    public async refreshOnTabOpen(): Promise<void> {
        await this.refresh({ manual: true });
    }

    public isCurrentStrategyAddable(): boolean {
        return isWorkerSupportedStrategyKey(state.currentStrategyKey);
    }

    /**
     * Match the data-mining-manager's notion of a synthetic symbol: the current
     * chart symbol equals the derived synthetic of the loaded synthetic pair.
     * Accept display separators too, so ZEC+APT matches the derived ZECAPT key.
     */
    private isCurrentSymbolSynthetic(): boolean {
        const pair = dataMiningManager.getSyntheticPairMetadata();
        return matchesSyntheticSymbol(state.currentSymbol, pair);
    }

    private getLocalSyntheticMemberRecords(): LocalSyntheticMemberRecord[] {
        return readLocalSyntheticMembers().map((stored, index) => {
            const config = settingsManager.loadStrategyConfig(stored.configName);
            const syntheticPair = config?.syntheticPair ?? null;
            const fallbackSymbol = syntheticPair
                ? deriveSyntheticSymbol(syntheticPair.baseSymbol, syntheticPair.quoteSymbol)
                : parseAlertConfigNameFromStreamId(stored.streamId) ?? "Synthetic";
            const symbol = config?.symbol ?? fallbackSymbol;
            const interval = config?.interval ?? "";
            const strategyKey = config?.strategyKey ?? "";
            return {
                stored,
                config,
                syntheticPair,
                interval,
                strategyKey,
                strategyParams: config?.strategyParams ?? {},
                backtestSettings: (config?.backtestSettings as unknown as Record<string, unknown> | undefined) ?? {},
                subscription: {
                    id: -(index + 1),
                    stream_id: stored.streamId,
                    enabled: 1,
                    symbol,
                    interval,
                    strategy_key: strategyKey,
                    strategy_params_json: JSON.stringify(config?.strategyParams ?? {}),
                    backtest_settings_json: JSON.stringify(config?.backtestSettings ?? {}),
                    freshness_bars: 1,
                    notify_telegram: 0,
                    notify_exit: 0,
                    candle_limit: state.ohlcvData.length,
                    last_processed_closed_candle_time: 0,
                    last_run_at: new Date().toISOString(),
                    last_status: config ? "local synthetic" : "missing saved config",
                    created_at: stored.createdAt,
                    updated_at: stored.updatedAt,
                    committee_tag: LOCAL_SYNTHETIC_COMMITTEE_TAG,
                },
            };
        });
    }

    private getWorkerSyntheticFallbackRecords(members: readonly AlertSubscription[]): LocalSyntheticMemberRecord[] {
        const records: LocalSyntheticMemberRecord[] = [];
        const currentPair = dataMiningManager.getSyntheticPairMetadata();
        const currentChartSynthetic = matchesSyntheticSymbol(state.currentSymbol, currentPair);
        for (const member of members) {
            const configName = parseAlertConfigNameFromStreamId(member.stream_id);
            if (!configName) continue;
            const config = settingsManager.loadStrategyConfig(configName);
            const syntheticPair = config?.syntheticPair
                ?? (currentChartSynthetic && matchesSyntheticSymbol(member.symbol, currentPair) ? currentPair : null);
            if (!syntheticPair) continue;
            records.push({
                stored: {
                    streamId: member.stream_id,
                    configName,
                    createdAt: member.created_at,
                    updatedAt: member.updated_at,
                },
                config,
                syntheticPair,
                interval: config?.interval ?? member.interval,
                strategyKey: config?.strategyKey ?? member.strategy_key,
                strategyParams: config?.strategyParams ?? parseStrategyParamsJson(member.strategy_params_json),
                backtestSettings: (config?.backtestSettings as unknown as Record<string, unknown> | undefined)
                    ?? parseJsonRecord(member.backtest_settings_json),
                subscription: {
                    ...member,
                    last_status: "local synthetic fallback",
                    committee_tag: LOCAL_SYNTHETIC_COMMITTEE_TAG,
                },
            });
        }
        return records;
    }

    private async evaluateLocalSyntheticMembers(
        records: readonly LocalSyntheticMemberRecord[]
    ): Promise<Map<string, CommitteeMemberState>> {
        const states = new Map<string, CommitteeMemberState>();
        const currentPair = dataMiningManager.getSyntheticPairMetadata();
        const latestCandle = state.ohlcvData[state.ohlcvData.length - 1] ?? null;
        const latestClose = latestCandle && Number.isFinite(latestCandle.close) ? latestCandle.close : null;
        const closedCandleTimeSec = latestCandle ? this.candleToSec(latestCandle) : Number.NaN;

        for (const record of records) {
            const { subscription } = record;
            if (!record.syntheticPair) {
                states.set(subscription.stream_id, this.buildLocalSyntheticErrorState(
                    subscription,
                    "missing_synthetic_pair_metadata",
                    latestClose,
                    closedCandleTimeSec
                ));
                continue;
            }
            if (
                !currentPair
                || !matchesSyntheticSymbol(state.currentSymbol, record.syntheticPair)
                || !matchesSyntheticSymbol(state.currentSymbol, currentPair)
                || state.currentInterval !== record.interval
            ) {
                states.set(subscription.stream_id, this.buildLocalSyntheticErrorState(
                    subscription,
                    "load_this_synthetic_chart_to_evaluate",
                    latestClose,
                    closedCandleTimeSec
                ));
                continue;
            }
            if (state.ohlcvData.length < 2) {
                states.set(subscription.stream_id, this.buildLocalSyntheticErrorState(
                    subscription,
                    "insufficient_loaded_synthetic_data",
                    latestClose,
                    closedCandleTimeSec
                ));
                continue;
            }

            await loadBuiltInStrategyByKey(record.strategyKey);
            const evaluation = evaluateLatestEntrySignal({
                strategyKey: record.strategyKey,
                candles: state.ohlcvData,
                strategyParams: record.strategyParams,
                backtestSettings: record.backtestSettings as unknown as BacktestSettings,
                freshnessBars: 1,
            });
            const latestEntry = evaluation.latestEntry
                ? {
                    direction: evaluation.latestEntry.direction,
                    signalTimeSec: evaluation.latestEntry.signalTimeSec,
                    signalPrice: evaluation.latestEntry.signal.price,
                    entryPrice: evaluation.latestEntry.entryPrice,
                    signalAgeBars: evaluation.latestEntry.signalAgeBars,
                    isFresh: evaluation.latestEntry.isFresh,
                    fingerprint: evaluation.latestEntry.fingerprint,
                }
                : null;

            states.set(subscription.stream_id, {
                streamId: subscription.stream_id,
                ok: evaluation.ok,
                reason: evaluation.reason ?? null,
                symbol: subscription.symbol,
                interval: subscription.interval,
                strategyKey: subscription.strategy_key,
                evaluatedAt: new Date().toISOString(),
                closedCandleTimeSec: Number.isFinite(closedCandleTimeSec) ? closedCandleTimeSec : null,
                latestClose,
                latestTrade: evaluation.latestTrade,
                latestEntry,
                tradeWindows: evaluation.tradeWindows ?? null,
                lastStatus: evaluation.ok ? "local synthetic" : evaluation.reason ?? "local synthetic error",
                lastRunAt: new Date().toISOString(),
                updatedAt: record.stored.updatedAt,
                committeeTag: LOCAL_SYNTHETIC_COMMITTEE_TAG,
            });
        }

        return states;
    }

    private buildLocalSyntheticErrorState(
        subscription: AlertSubscription,
        reason: string,
        latestClose: number | null,
        closedCandleTimeSec: number
    ): CommitteeMemberState {
        return {
            streamId: subscription.stream_id,
            ok: false,
            reason,
            symbol: subscription.symbol,
            interval: subscription.interval,
            strategyKey: subscription.strategy_key,
            evaluatedAt: new Date().toISOString(),
            closedCandleTimeSec: Number.isFinite(closedCandleTimeSec) ? closedCandleTimeSec : null,
            latestClose,
            latestTrade: null,
            latestEntry: null,
            tradeWindows: null,
            lastStatus: reason,
            lastRunAt: null,
            updatedAt: subscription.updated_at,
            committeeTag: LOCAL_SYNTHETIC_COMMITTEE_TAG,
        };
    }

    private async refresh(options: { manual: boolean }): Promise<void> {
        if (this.refreshInFlight) return;
        this.refreshInFlight = true;
        // Diagnostic: capture each stage so we can see exactly where it breaks.
        const diag: Record<string, unknown> = {
            at: new Date().toISOString(),
            manual: options.manual,
            workerUrl: "",
        };
        try {
            diag.workerUrl = alertService.getWorkerUrl() || "(empty)";
            const localRecords = this.getLocalSyntheticMemberRecords();
            const localStates = await this.evaluateLocalSyntheticMembers(localRecords);
            diag.localSyntheticMembers = localRecords.map((record) => ({
                stream_id: record.subscription.stream_id,
                symbol: record.subscription.symbol,
                interval: record.subscription.interval,
                strategy_key: record.subscription.strategy_key,
                hasConfig: Boolean(record.config),
            }));

            // 1. Health gate. Only block on initial/manual refresh so a transient
            //    health error during auto-poll doesn't blank the table.
            if (options.manual || this.members.length === 0) {
                const health = await alertService.healthCheck();
                diag.health = {
                    ok: health.ok,
                    error: health.error ?? null,
                    service: health.service ?? null,
                    supportedStrategyKeys: health.supportedStrategyKeys?.length ?? null,
                };
                const wasReachable = this.workerReachable;
                this.workerReachable = Boolean(health.ok);
                if (!this.workerReachable) {
                    if (localRecords.length === 0) {
                        this.members = [];
                        this.memberStates.clear();
                        diag.stage = "health_failed";
                        diag.membersBeforeFilter = 0;
                        this.lastDiagnostic = JSON.stringify(diag, null, 2);
                        this.renderDiagnostic();
                        this.renderHealthFail(
                            health.error
                                ? `Worker unreachable: ${health.error}. Configure it in the Alerts tab, or add a synthetic chart member for local evaluation.`
                                : "Worker not configured. Set the Worker URL in the Alerts tab, or add a synthetic chart member for local evaluation."
                        );
                        return;
                    }
                    diag.healthFallback = "rendering_local_synthetic_members";
                }
                if (wasReachable !== this.workerReachable) {
                    debugLogger.event("signal_committee.health_changed", { ok: this.workerReachable });
                    if (this.workerReachable) {
                        void this.loadAlertRule();
                    }
                }
            } else {
                diag.health = "(skipped — auto refresh, members already loaded)";
            }

            // 2. List worker committee-tagged members when the worker is reachable.
            const workerMembers = this.workerReachable
                ? await alertService.listCommitteeSubscriptions()
                : [];
            const workerLocalRecords = this.getWorkerSyntheticFallbackRecords(workerMembers);
            const localRecordStreamIds = new Set([
                ...localRecords.map((record) => record.subscription.stream_id),
                ...workerLocalRecords.map((record) => record.subscription.stream_id),
            ]);
            const remoteWorkerMembers = workerMembers.filter((member) => !localRecordStreamIds.has(member.stream_id));
            const workerLocalStates = await this.evaluateLocalSyntheticMembers(workerLocalRecords);
            for (const [streamId, memberState] of workerLocalStates) {
                localStates.set(streamId, memberState);
            }
            diag.listCount = workerMembers.length;
            diag.listMembers = workerMembers.map((m) => ({
                stream_id: m.stream_id,
                symbol: m.symbol,
                interval: m.interval,
                strategy_key: m.strategy_key,
                committee_tag: m.committee_tag ?? null,
                enabled: m.enabled,
                last_status: m.last_status,
                last_run_at: m.last_run_at,
            }));
            diag.workerSyntheticFallbackMembers = workerLocalRecords.map((record) => ({
                stream_id: record.subscription.stream_id,
                symbol: record.subscription.symbol,
                interval: record.subscription.interval,
                strategy_key: record.subscription.strategy_key,
                hasConfig: Boolean(record.config),
            }));
            this.members = [
                ...localRecords.map((record) => record.subscription),
                ...workerLocalRecords.map((record) => record.subscription),
                ...remoteWorkerMembers,
            ].slice(0, MEMBER_HARD_CAP);
            if (this.members.length === 0) {
                this.memberStates.clear();
                diag.stage = "no_members";
                this.lastDiagnostic = JSON.stringify(diag, null, 2);
                this.renderDiagnostic();
                this.renderEmptyMembers();
                return;
            }

            // 3. Batched state read (with fallback handled inside alertService).
            const streamIds = remoteWorkerMembers
                .slice(0, Math.max(0, MEMBER_HARD_CAP - localRecordStreamIds.size))
                .map((m) => m.stream_id);
            diag.batchedRequest = { streamIds };
            const result = streamIds.length > 0
                ? await alertService.getCommitteeState(streamIds)
                : { ok: true, scanned: 0, truncated: false, states: [] };
            diag.batchedResponse = {
                ok: result.ok,
                scanned: result.scanned,
                truncated: result.truncated,
                statesCount: result.states.length,
            };
            this.memberStates = new Map(localStates);
            for (const s of result.states) {
                this.memberStates.set(s.streamId, s);
            }
            // Diagnostic per-member state: shows exactly what the worker returned,
            // including the vote direction, isOpen, latestClose, tradeWindows.
            diag.memberStates = this.members.map((m) => {
                const s = this.memberStates.get(m.stream_id);
                if (!s) return { stream_id: m.stream_id, present: false };
                return {
                    stream_id: m.stream_id,
                    ok: s.ok,
                    reason: s.reason,
                    direction: s.latestEntry?.direction ?? null,
                    isOpen: s.latestTrade?.isOpen ?? null,
                    entryTimeSec: s.latestTrade?.entryTimeSec ?? null,
                    entryPrice: s.latestTrade?.entryPrice ?? null,
                    latestClose: s.latestClose,
                    tradeWindowsCount: Array.isArray(s.tradeWindows) ? s.tradeWindows.length : null,
                    lastStatus: s.lastStatus,
                };
            });
            this.latestStatesAtIso = new Date().toISOString();
            diag.stage = "rendered";

            this.renderMembers();
            this.warnStaleCronIfAny();
            this.lastDiagnostic = JSON.stringify(diag, null, 2);
            this.renderDiagnostic();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diag.stage = "exception";
            diag.error = message;
            this.lastDiagnostic = JSON.stringify(diag, null, 2);
            this.renderDiagnostic();
            debugLogger.error("signal_committee.refresh_failed", { error: message });
            uiManager.showToast(`Committee refresh failed: ${message}`, "error");
        } finally {
            this.refreshInFlight = false;
        }
    }

    private renderDiagnostic(): void {
        const dom = this.getDom();
        if (dom.signalCommitteeDiagnosticPre) {
            dom.signalCommitteeDiagnosticPre.textContent = this.lastDiagnostic || "(no diagnostic yet)";
        }
    }

    /**
     * Render the committee-score chart overlay in the current mode.
     *
     * - "current": every visible bar gets the live net vote (step histogram).
     * - "historical": each bar gets the per-bar net vote reconstructed from
     *   members' tradeWindows. Bars before any member's first entry, or after
     *   all windows close, score 0.
     *
     * If the worker has not yet populated `tradeWindows`, "historical" mode
     * renders nothing (overlay cleared) rather than misleading the user with
     * an all-zero series.
     */
    private renderScoreOverlay(): void {
        if (this.overlayMode === "off") return;
        if (this.members.length === 0 || this.memberStates.size === 0) {
            chartManager.removeCommitteeScoreOverlay();
            return;
        }

        if (this.overlayMode === "current") {
            const nowSec = Math.floor(Date.now() / 1000);
            const aggregate = aggregateScore(this.buildScoreRows(), nowSec);
            const bars = state.ohlcvData.map((candle) => ({
                time: candle.time as unknown as import("lightweight-charts").Time,
                value: aggregate.score,
            }));
            chartManager.setCommitteeScoreOverlay(bars);
            return;
        }

        // historical mode
        const overlayMembers = this.members.map((m) => {
            const s = this.memberStates.get(m.stream_id);
            return {
                streamId: m.stream_id,
                tradeWindows: Array.isArray(s?.tradeWindows) ? s!.tradeWindows : null,
            };
        });
        const anyHasWindows = overlayMembers.some((m) => m.tradeWindows && m.tradeWindows.length > 0);
        if (!anyHasWindows) {
            // Worker hasn't populated tradeWindows yet (pre-redploy) — clear
            // rather than show a misleading flat-zero histogram.
            chartManager.removeCommitteeScoreOverlay();
            return;
        }
        const bars = state.ohlcvData.map((candle) => ({ candle, sec: this.candleToSec(candle) }));
        const scores = computeCommitteeOverlayScores(bars, overlayMembers);
        const points = toOverlayPoints(bars, scores as unknown as ReadonlyArray<number>, (b) => {
            // Lightweight-charts accepts the bar's original time value.
            return b.candle.time as unknown as import("lightweight-charts").Time;
        });
        chartManager.setCommitteeScoreOverlay(points as Array<{ time: import("lightweight-charts").Time; value: number }>);
    }

    /** Extract unix seconds from a chart candle for window containment tests. */
    private candleToSec(candle: { time: unknown }): number {
        const t = candle.time;
        if (typeof t === "number") return t < 1e12 ? t : Math.floor(t / 1000);
        if (typeof t === "string") {
            const ms = Date.parse(t);
            if (Number.isFinite(ms)) return Math.floor(ms / 1000);
        }
        return Number.NaN;
    }

    private warnStaleCronIfAny(): void {
        const nowSec = Math.floor(Date.now() / 1000);
        const workerMembers = this.members.filter((m) => !isLocalSyntheticStreamId(m.stream_id));
        const localCount = this.members.length - workerMembers.length;
        const anyStale = workerMembers.some((m) => {
            const runAtMs = m.last_run_at ? Date.parse(m.last_run_at) : NaN;
            if (!Number.isFinite(runAtMs)) return true;
            return nowSec - Math.floor(runAtMs / 1000) > HEALTH_STALE_RUN_AT_SEC;
        });
        const dom = this.getDom();
        if (anyStale && this.workerReachable) {
            dom.signalCommitteeStatus.textContent =
                "Worker reachable but at least one member has not been evaluated recently. Verify cron triggers are set.";
        } else if (this.workerReachable) {
            dom.signalCommitteeStatus.textContent =
                `${this.members.length} member${this.members.length === 1 ? "" : "s"} on the committee${localCount > 0 ? ` (${localCount} local synthetic)` : ""}.`;
        } else if (localCount > 0) {
            dom.signalCommitteeStatus.textContent =
                `${localCount} local synthetic member${localCount === 1 ? "" : "s"} evaluated from the loaded chart. Worker-backed members are unavailable.`;
        }
    }

    private async addCurrentConfiguration(): Promise<void> {
        const strategyKey = state.currentStrategyKey.trim();
        if (!strategyKey) {
            uiManager.showToast("No strategy selected.", "warning");
            return;
        }
        if (!isWorkerSupportedStrategyKey(strategyKey)) {
            uiManager.showToast(
                "Signal Committee local synthetic mode supports chart-data strategies only. Cross-symbol and 1s-Polymarket strategies are not supported here.",
                "warning"
            );
            return;
        }

        const context = resolveCurrentAlertSubscriptionContext();
        if (!context) {
            uiManager.showToast("No current chart context to add.", "error");
            return;
        }

        const name = window.prompt("Configuration name", context.configName ?? `${context.symbol}-${context.interval}`);
        if (!name || !name.trim()) return;
        const trimmed = name.trim();

        try {
            const existingConfig = settingsManager.loadStrategyConfig(trimmed);
            let savedConfig = settingsManager.saveStrategyConfig(trimmed);
            const existingSyntheticPair = existingConfig?.syntheticPair ?? null;
            const shouldUseLocalSynthetic =
                this.isCurrentSymbolSynthetic()
                || matchesSyntheticSymbol(state.currentSymbol, existingSyntheticPair);
            if (shouldUseLocalSynthetic && existingSyntheticPair && !savedConfig.syntheticPair) {
                savedConfig = settingsManager.upsertStrategyConfig({
                    ...savedConfig,
                    syntheticPair: existingSyntheticPair,
                });
            }
            if (shouldUseLocalSynthetic) {
                const streamId = buildLocalSyntheticStreamId(
                    context.symbol,
                    context.interval,
                    context.strategyKey,
                    trimmed
                );
                const now = new Date().toISOString();
                const members = readLocalSyntheticMembers();
                const existingIndex = members.findIndex((member) => member.streamId === streamId);
                const stored: LocalSyntheticCommitteeMember = {
                    streamId,
                    configName: savedConfig.name,
                    createdAt: existingIndex >= 0 ? members[existingIndex].createdAt : now,
                    updatedAt: now,
                };
                if (existingIndex >= 0) {
                    members[existingIndex] = stored;
                } else {
                    members.push(stored);
                }
                writeLocalSyntheticMembers(members);
                uiManager.showToast(`Added "${trimmed}" as a local synthetic committee member.`, "success");
                await this.refresh({ manual: true });
                return;
            }
            const configName = context.configName ?? trimmed;
            const streamId = buildAlertStreamId(
                context.symbol,
                context.interval,
                context.strategyKey,
                configName
            );
            await alertService.upsertSubscription({
                streamId,
                symbol: context.symbol,
                interval: context.interval,
                strategyKey: context.strategyKey,
                configName,
                strategyParams: context.strategyParams,
                backtestSettings: context.backtestSettings,
                freshnessBars: 1,
                notifyTelegram: false,
                enabled: true,
                committeeTag: DEFAULT_COMMITTEE_TAG,
            });
            uiManager.showToast(`Added "${trimmed}" to the committee.`, "success");
            await this.refresh({ manual: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            uiManager.showToast(`Failed to add configuration: ${message}`, "error");
        }
    }

    private async loadConfiguration(streamId: string): Promise<void> {
        const configName = parseAlertConfigNameFromStreamId(streamId);
        if (!configName) {
            uiManager.showToast("This member has no saved configuration name to load.", "info");
            return;
        }
        const { applySavedStrategyConfig } = await import("./handlers/settings-handlers");
        const ok = await applySavedStrategyConfig(configName);
        if (!ok) {
            uiManager.showToast(`Saved configuration "${configName}" not found locally.`, "warning");
            return;
        }
        uiManager.showToast(`Loaded configuration "${configName}".`, "success");
    }

    private async removeConfiguration(streamId: string): Promise<void> {
        const configName = parseAlertConfigNameFromStreamId(streamId);
        const label = configName ?? streamId;
        if (!window.confirm(`Remove "${label}" from the committee?`)) return;
        try {
            if (isLocalSyntheticStreamId(streamId)) {
                writeLocalSyntheticMembers(readLocalSyntheticMembers().filter((member) => member.streamId !== streamId));
                uiManager.showToast(`Removed "${label}".`, "success");
                await this.refresh({ manual: true });
                return;
            }
            await alertService.deleteSubscription(streamId, true);
            uiManager.showToast(`Removed "${label}".`, "success");
            await this.refresh({ manual: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            uiManager.showToast(`Failed to remove: ${message}`, "error");
        }
    }

    /**
     * Load the alert rule for the default committee tag and populate the UI.
     * If the worker has no rule yet, leave the inputs at their visual defaults
     * (which mirror the migration defaults: enabled=false, long=2, short=-2).
     */
    private async loadAlertRule(): Promise<void> {
        try {
            const rules = await alertService.listCommitteeAlertRules();
            const rule = rules.find((r) => r.committeeTag === DEFAULT_COMMITTEE_TAG);
            const dom = this.getDom();
            if (!rule) {
                dom.signalCommitteeAlertEnabled.checked = false;
                dom.signalCommitteeAlertLongThreshold.value = "2";
                dom.signalCommitteeAlertShortThreshold.value = "-2";
                return;
            }
            dom.signalCommitteeAlertEnabled.checked = rule.enabled;
            dom.signalCommitteeAlertLongThreshold.value = String(rule.longThreshold);
            dom.signalCommitteeAlertShortThreshold.value = String(rule.shortThreshold);
        } catch {
            // Worker doesn't support the endpoint yet — leave defaults.
        }
    }

    private async saveAlertRule(): Promise<void> {
        const dom = this.getDom();
        const enabled = dom.signalCommitteeAlertEnabled.checked;
        const longThreshold = Math.max(1, Math.floor(Number(dom.signalCommitteeAlertLongThreshold.value) || 2));
        const shortThreshold = Math.min(-1, Math.floor(Number(dom.signalCommitteeAlertShortThreshold.value) || -2));
        try {
            const saved = await alertService.upsertCommitteeAlertRule({
                committeeTag: DEFAULT_COMMITTEE_TAG,
                enabled,
                longThreshold,
                shortThreshold,
            });
            if (!saved) {
                uiManager.showToast("Worker does not support committee alert rules yet.", "warning");
                return;
            }
            uiManager.showToast(
                enabled ? "Committee alerts enabled." : "Committee alerts disabled.",
                "success"
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            uiManager.showToast(`Failed to save alert rule: ${message}`, "error");
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private buildScoreRows(): Array<CommitteeScoreRow & { voteDirection: "long" | "short" | null }> {
        return this.members.map((m) => {
            const s = this.memberStates.get(m.stream_id);
            if (!s || !s.ok) {
                return {
                    streamId: m.stream_id,
                    ok: false,
                    latestTrade: null,
                    latestClose: null,
                    voteDirection: null,
                };
            }
            const trade = s.latestTrade;
            const direction = s.latestEntry?.direction ?? null;
            return {
                streamId: m.stream_id,
                ok: true,
                latestTrade: trade
                    ? {
                        entryTimeSec: trade.entryTimeSec,
                        entryPrice: trade.entryPrice,
                        isOpen: trade.isOpen,
                    }
                    : null,
                latestClose: s.latestClose ?? null,
                voteDirection: direction,
            };
        });
    }

    private renderMembers(): void {
        const dom = this.getDom();
        const scoreRows = this.buildScoreRows();
        const nowSec = Math.floor(Date.now() / 1000);
        const aggregate: CommitteeAggregate = aggregateScore(scoreRows, nowSec);

        const header = renderCommitteeHeader(aggregate, this.latestStatesAtIso);
        dom.signalCommitteeScore.textContent = header.score;
        dom.signalCommitteeLongShort.textContent = header.longShort;
        dom.signalCommitteeAvgAge.textContent = header.avgAge;
        dom.signalCommitteeAvgGain.textContent = header.avgGain;
        dom.signalCommitteeLastUpdated.textContent = header.lastUpdated;

        const views: CommitteeRowView[] = this.members.map((m) => this.memberToView(m, nowSec));
        dom.signalCommitteeTableBody.innerHTML = renderCommitteeRows(views);

        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";

        this.renderScoreOverlay();
    }

    private memberToView(m: AlertSubscription, nowSec: number): CommitteeRowView {
        const s = this.memberStates.get(m.stream_id);
        const configName = parseAlertConfigNameFromStreamId(m.stream_id) ?? m.strategy_key;
        const direction = s?.latestEntry?.direction ?? null;
        const trade = s?.latestTrade ?? null;
        const isOpen = Boolean(trade?.isOpen);

        let directionLabel = "—";
        let voteLabel = "0";
        if (s && s.ok && isOpen && direction) {
            directionLabel = direction === "long" ? "LONG" : "SHORT";
            voteLabel = direction === "long" ? "+1" : "-1";
        } else if (s && s.ok) {
            directionLabel = "FLAT";
            voteLabel = "0";
        } else if (s && !s.ok && s.reason === "no_cached_state") {
            // Cron never wrote state. The most useful label depends on WHY:
            // if last_status shows an error, surface that; else "PENDING".
            directionLabel = m.last_status && /error/i.test(m.last_status) ? "ERROR" : "PENDING";
        } else if (s && !s.ok) {
            directionLabel = "ERROR";
        }

        const okRow = s?.ok === true;
        const ageSec = okRow && trade
            ? ageSecForRow({
                streamId: m.stream_id,
                ok: true,
                latestTrade: {
                    entryTimeSec: trade.entryTimeSec,
                    entryPrice: trade.entryPrice,
                    isOpen: trade.isOpen,
                },
                latestClose: s?.latestClose ?? null,
            }, nowSec)
            : null;
        const gainPct = okRow && trade
            ? gainPctForRow({
                streamId: m.stream_id,
                ok: true,
                latestTrade: {
                    entryTimeSec: trade.entryTimeSec,
                    entryPrice: trade.entryPrice,
                    isOpen: trade.isOpen,
                },
                latestClose: s?.latestClose ?? null,
                voteDirection: direction,
            })
            : null;

        const ageLabel = formatAgeShort(ageSec);
        const gainLabel = formatPercentSigned(gainPct);

        let statusLabel = "—";
        let statusTone: "ok" | "warn" | "error" = "ok";
        if (!s) {
            // State map miss entirely. last_status is the only signal we have.
            if (m.last_status && /error/i.test(m.last_status)) {
                statusLabel = m.last_status;
                statusTone = "error";
            } else {
                statusLabel = m.last_status ?? "no state";
                statusTone = "warn";
            }
        } else if (!s.ok) {
            // Cached state missing/error. Prefer the cron's last_status (which
            // records WHY evaluation failed, e.g. "error:Binance API ..."),
            // falling back to the cached-state reason.
            if (m.last_status && /error/i.test(m.last_status)) {
                statusLabel = m.last_status;
                statusTone = "error";
            } else {
                statusLabel = s.reason ?? "error";
                statusTone = s.reason === "no_cached_state" ? "warn" : "error";
            }
        } else if (m.last_status && /error/i.test(m.last_status)) {
            statusLabel = m.last_status;
            statusTone = "error";
        } else {
            statusLabel = m.last_status ?? "ok";
        }

        // The full error string can be very long (multi-URL ban messages).
        // Truncate for the table cell; the diagnostic <pre> has the full text.
        if (statusLabel.length > 80) {
            statusLabel = statusLabel.slice(0, 77) + "...";
        }

        return {
            streamId: m.stream_id,
            configName,
            symbol: m.symbol,
            interval: m.interval,
            strategyKey: m.strategy_key,
            directionLabel,
            voteLabel,
            ageLabel,
            gainLabel,
            statusLabel,
            statusTone,
        };
    }

    private renderEmptyMembers(): void {
        const dom = this.getDom();
        dom.signalCommitteeScore.textContent = "—";
        dom.signalCommitteeLongShort.textContent = "0L / 0S / 0Flat";
        dom.signalCommitteeAvgAge.textContent = "—";
        dom.signalCommitteeAvgGain.textContent = "—";
        dom.signalCommitteeLastUpdated.textContent = "—";
        dom.signalCommitteeStatus.textContent =
            "Worker connected. No committee members yet — click Add Current Configuration to start.";
        dom.signalCommitteeTableBody.innerHTML = renderCommitteeRows([]);
        // Show the content (status bar + empty table) so the user sees the
        // real "connected, add a member" state. Hide the static pre-load
        // empty-state illustration.
        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";
        chartManager.removeCommitteeScoreOverlay();
    }

    private renderHealthFail(message: string): void {
        const dom = this.getDom();
        dom.signalCommitteeScore.textContent = "—";
        dom.signalCommitteeLongShort.textContent = "—";
        dom.signalCommitteeAvgAge.textContent = "—";
        dom.signalCommitteeAvgGain.textContent = "—";
        dom.signalCommitteeLastUpdated.textContent = "—";
        dom.signalCommitteeStatus.textContent = message;
        dom.signalCommitteeTableBody.innerHTML = renderEmptyHealthFail(message);
        // Show content so the status bar + table (with the error message) are
        // visible. The static empty-state is for pre-load only.
        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";
        chartManager.removeCommitteeScoreOverlay();
    }
}

export const signalCommitteeService = new SignalCommitteeService();
