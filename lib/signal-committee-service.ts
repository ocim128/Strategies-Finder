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
import { dataManager } from "./data-manager";
import { storeSqliteCandles } from "./local-sqlite-api";
import {
    aggregateSyntheticBars,
    buildSyntheticPairDataset,
    deriveSyntheticSymbol,
    pickSourceInterval,
    resolveSyntheticSourceBars,
} from "../scripts/lib/synthetic-pair";
import { getSyntheticPairMetadata } from "./synthetic-pair-session";
import { settingsManager } from "./settings-manager";
import { state } from "./state";
import { chartManager } from "./chart-manager";
import { uiManager } from "./ui-manager";
import { debugLogger } from "./debug-logger";
import { evaluateLatestEntrySignal } from "./signal-entry-evaluator";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import { parseSyntheticPairToken } from "./finder-manager";
import { parseBatchSymbols } from "./batch-backtest/batch-backtest-runner";
import { resolveCurrentAlertSubscriptionContext } from "./current-alert-subscription";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import {
    aggregateScore,
    aggregateLegScores,
    type CommitteeAggregate,
    type CommitteeScoreRow,
    type LegScoreRow,
} from "./signal-committee-score";
import {
    computeCommitteeOverlayScores,
    pickScoreChangePoints,
    chartOverlayVoteMultiplier,
    type TradeWindow,
} from "./signal-committee-overlay";
import {
    computeScoreEdgeReport,
    formatScoreEdgeAiExport,
    type ScoreEdgeReport,
} from "./signal-committee-edge";
import {
    buildCommitteeRowView,
    renderCommitteeHeader,
    renderCommitteeRows,
    renderEmptyHealthFail,
    renderLegLeaderboard,
    renderScoreEdgeReport,
} from "./signal-committee-renderer";
import { copyToClipboard } from "./browser-transfer";
import { createSignalCommitteeDom, type SignalCommitteeDom } from "./signal-committee-dom";
import {
    readSignalCommitteePrefs,
    writeSignalCommitteePrefs,
    type SignalCommitteePrefs,
} from "./signal-committee-prefs";
import type { StrategyConfig } from "./settings-model";
import type { BacktestSettings } from "./types/strategies";

const HEALTH_STALE_RUN_AT_SEC = 600; // 10 minutes since last_run_at = stale cron

/**
 * Committee chart overlay modes, ordered as the toggle button cycles them.
 * Adding a new mode only requires appending to this tuple — the rotation,
 * button label switch, and TypeScript union all derive from it.
 *
 * "historical" is the only on-mode: it stamps one wick marker per bar where
 * the reconstructed committee score changes (plus the latest bar), so the
 * user reads the score evolution across the whole chart (e.g. +3 a day ago,
 * +2 in the last 40 minutes) instead of a single live verdict. The previous
 * "current" mode showed only the latest-bar score, which duplicated the
 * side-panel badge without adding chart context — removed.
 */
const COMMITTEE_OVERLAY_MODES = ["off", "historical"] as const;
type CommitteeOverlayMode = typeof COMMITTEE_OVERLAY_MODES[number];

const COMMITTEE_OVERLAY_BUTTON_LABEL: Record<CommitteeOverlayMode, string> = {
    off: "Show Score on Chart",
    historical: "Score: Historical (click to hide)",
};

const DEFAULT_COMMITTEE_TAG = "default";
const LOCAL_SYNTHETIC_COMMITTEE_TAG = "local_synthetic";
const LOCAL_SYNTHETIC_STREAM_PREFIX = "local-synthetic:";
// Member cap matches the worker's `listCommitteeSubscriptions` LIMIT (500).
// State reads are chunked client-side at COMMITTEE_STATE_BATCH_SIZE because the
// worker's getCommitteeState caps at MAX_BATCH=100 per request (one D1 `?` per
// IN value). Without chunking, members past 100 would silently get no state.
const MEMBER_HARD_CAP = 500;
const COMMITTEE_STATE_BATCH_SIZE = 100;
// Synthetic committee members are scored on the chart by their tradeWindows.
// The worker feeds each member this many ratio candles per evaluation, which
// bounds how far back the chart overlay can reach. 500 (~83 days at 4h) was
// too tight: multi-year charts had bars older than the oldest supplied candle
// silently score 0. 2000 (~333 days at 4h) gives ~1 year of on-chart coverage
// without straining the worker's CPU budget at the documented committee target
// (<=25 members). The browser-side repair path in `applyWorkerSyntheticRepairs`
// raises existing D1 rows below this value on the next refresh, so raising this
// constant migrates already-registered members without a manual backfill.
const SYNTHETIC_WORKER_CANDLE_LIMIT = 2000;
const SYNTHETIC_COMMITTEE_SYNC_MIN_SOURCE_BARS = 50_000;
const LOCAL_SYNTHETIC_MEMBERS_STORAGE = {
    key: "signal_committee_local_synthetic_members",
    schema: "signal_committee_local_synthetic_members",
    // v2: added optional `disabled` flag so local members can be deactivated
    // without deletion (mirrors worker `enabled=0`). v1 rows migrate with
    // `disabled=false`.
    version: 2,
} as const;

interface LocalSyntheticCommitteeMember {
    streamId: string;
    configName: string;
    createdAt: string;
    updatedAt: string;
    /** v2. True when the user deactivated this local member. */
    disabled?: boolean;
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

function normalizeSymbolKey(value: string): string {
    return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function symbolsMatch(left: string, right: string): boolean {
    return normalizeSymbolKey(left) === normalizeSymbolKey(right);
}

/**
 * Summarize a member's tradeWindows for the diagnostic panel. The point is to
 * answer "why do old bars score 0?" without more round-trips:
 *   - `count` small + `spanDays` years-long  -> strategy genuinely fires few
 *     trades (not a bug; old bars legitimately have no window).
 *   - `count` near the worker cap + `earliestSec` only a few months ago ->
 *     tradeWindows are being truncated; check `SYNTHETIC_WORKER_CANDLE_LIMIT`
 *     (candles supplied to the strategy) rather than `TRADE_WINDOWS_CAP`
 *     (which only matters if `count` saturates it).
 *   - otherwise (count sparse, spanDays short) -> some other cap or stale
 *     data; dig further.
 * `earliestSec`/`latestSec` are unix seconds (null when no windows).
 */
function tradeWindowsRange(
    windows: ReadonlyArray<TradeWindow> | null | undefined
): { count: number; range: { earliestSec: number | null; latestSec: number | null; spanDays: number | null } } {
    if (!Array.isArray(windows) || windows.length === 0) {
        return { count: 0, range: { earliestSec: null, latestSec: null, spanDays: null } };
    }
    let earliest = Infinity;
    let latest = -Infinity;
    for (const w of windows) {
        const entry = w[0];
        const exit = w[1];
        if (Number.isFinite(entry)) {
            if (entry < earliest) earliest = entry;
            if (entry > latest) latest = entry;
        }
        if (typeof exit === "number" && Number.isFinite(exit)) {
            if (exit > latest) latest = exit;
        }
    }
    const earliestSec = Number.isFinite(earliest) ? earliest : null;
    const latestSec = Number.isFinite(latest) ? latest : null;
    const spanDays = earliestSec !== null && latestSec !== null
        ? Math.round((latestSec - earliestSec) / 86400)
        : null;
    return { count: windows.length, range: { earliestSec, latestSec, spanDays } };
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

function readSyntheticPairFromSettingsJson(
    value: string
): { baseSymbol: string; quoteSymbol: string } | null {
    const settings = parseJsonRecord(value);
    const raw = settings.syntheticPair;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    const baseSymbol = typeof candidate.baseSymbol === "string" ? candidate.baseSymbol.trim().toUpperCase() : "";
    const quoteSymbol = typeof candidate.quoteSymbol === "string" ? candidate.quoteSymbol.trim().toUpperCase() : "";
    return baseSymbol && quoteSymbol && baseSymbol !== quoteSymbol
        ? { baseSymbol, quoteSymbol }
        : null;
}

function parseStrategyKeyFromStreamId(streamId: string): string | null {
    const beforeConfig = streamId.split(":cfg:", 1)[0] ?? "";
    const parts = beforeConfig.split(":");
    const key = parts.length >= 3 ? parts.slice(2).join(":").trim() : "";
    return key || null;
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
                    // v1 rows have no `disabled`; default to false (active).
                    disabled: candidate.disabled === true,
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
     *
     * Stored as the raw object so stringification can be deferred until the
     * diagnostic <details> is actually open; auto-refresh otherwise pays the
     * JSON.stringify + <pre> reflow cost on every tick for output nobody is
     * looking at.
     */
    private lastDiagnosticObj: Record<string, unknown> | null = null;
    /**
     * Latest Score Edge Report (deterministic forward-return edge of the
     * committee score on the current chart). Recomputed on every refresh when
     * historical overlay data is available; null otherwise. Rendered lazily
     * into the collapsible Score Edge Report section, like the diagnostic.
     */
    private lastScoreEdgeReport: ScoreEdgeReport | null = null;
    /**
     * Latest "Sync Synthetic Legs" skip report: which active members could not
     * be planned and why. Populated by `syncSyntheticLegs` whenever members are
     * skipped (all-skipped OR partial). Folded into the main diagnostic snapshot
     * by `refresh()` so the user can see the reasons without re-running sync.
     * Cleared at the start of each sync pass.
     */
    private lastSyntheticLegSyncSkip: {
        at: string;
        activeMemberCount: number;
        skipped: Array<{ streamId: string; symbol: string; reason: string }>;
    } | null = null;
    /**
     * Chart overlay mode:
     * - "off"        : no overlay
     * - "historical" : per-bar net vote reconstructed from each member's
     *                  tradeWindows (entrySec..exitSec), stamped as wick
     *                  markers on the chart. Requires worker support
     *                  (latest_state_json.tradeWindows).
     */
    private overlayMode: CommitteeOverlayMode = "off";

    private getDom(): SignalCommitteeDom {
        return this.dom ??= createSignalCommitteeDom();
    }

    /**
     * Fan out `runNow` across streams in parallel. The worker's `run-now`
     * handler is stateless across streams (each reads its own D1 row), so
     * there is no ordering dependency to honor, and the cron itself already
     * evaluates every enabled subscription concurrently every minute.
     */
    private async warmWorkerStateCache(
        streamIds: readonly string[]
    ): Promise<Array<{ streamId: string; status: string; error?: string }>> {
        return Promise.all(streamIds.map(async (streamId) => {
            try {
                const run = await alertService.runNow(streamId, true);
                return { streamId, status: run.status ?? "unknown" };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                debugLogger.warn("signal_committee.run_now_failed", { streamId, error: message });
                return { streamId, status: "error", error: message };
            }
        }));
    }

    /**
     * Fetch committee state for many stream ids, transparently chunking
     * requests at {@link COMMITTEE_STATE_BATCH_SIZE}. The worker's
     * `getCommitteeState` caps each request at MAX_BATCH=100 (one D1 `?` per
     * IN value) and silently truncates beyond that. Without chunking, members
     * past 100 would get no state and stop voting/displaying.
     *
     * Chunks run sequentially, not in parallel — each round trip already hits
     * the worker's full D1 quota for that request shape, and the cron itself
     * fans out across subscriptions concurrently every minute, so adding
     * client-side parallelism here would only risk tripping rate limits.
     */
    private async getCommitteeStateBatched(
        streamIds: readonly string[]
    ): Promise<Awaited<ReturnType<typeof alertService.getCommitteeState>>> {
        if (streamIds.length === 0) {
            return { ok: true, scanned: 0, truncated: false, states: [] };
        }
        const merged: Awaited<ReturnType<typeof alertService.getCommitteeState>> = {
            ok: true,
            scanned: 0,
            truncated: false,
            states: [],
        };
        for (let i = 0; i < streamIds.length; i += COMMITTEE_STATE_BATCH_SIZE) {
            const chunk = streamIds.slice(i, i + COMMITTEE_STATE_BATCH_SIZE);
            const result = await alertService.getCommitteeState(chunk);
            if (!result.ok) {
                // Surface the first failure but keep the partial states already
                // collected so the UI still renders whatever we have.
                merged.ok = false;
                merged.scanned += result.scanned;
                merged.states.push(...result.states);
                return merged;
            }
            merged.scanned += result.scanned;
            merged.truncated = merged.truncated || result.truncated;
            merged.states.push(...result.states);
        }
        return merged;
    }

    private async syncSyntheticLegs(): Promise<void> {
        const dom = this.getDom();
        const originalText = dom.signalCommitteeSyncSyntheticBtn.textContent ?? "Sync Synthetic Legs";
        dom.signalCommitteeSyncSyntheticBtn.disabled = true;
        dom.signalCommitteeSyncSyntheticBtn.textContent = "Syncing...";

        try {
            // Disabled members are intentionally paused and the worker's
            // run-with-candles endpoint rejects them ("Subscription is disabled.
            // Re-enable it before running manually."). Including one would abort
            // the whole sync via the outer catch. Filter them out up front so
            // only active members are synced, matching isMemberActive's contract.
            const members = (this.members.length > 0
                ? this.members
                : this.workerReachable
                    ? await alertService.listCommitteeSubscriptions()
                    : []).filter((m) => this.isMemberActive(m));
            const plans = new Map<string, {
                baseSymbol: string;
                quoteSymbol: string;
                sourceInterval: string;
                sourceBars: number;
                members: Array<{ streamId: string; interval: string; targetBars: number }>;
            }>();
            // Members that could not be planned, with the precise reason. Surfaced
            // in the empty-plans message and the diagnostic pane so the user can
            // see WHY sync skipped (e.g. "no synthetic chart loaded") instead of
            // only "No synthetic committee members to sync."
            const skippedMembers: Array<{ streamId: string; symbol: string; reason: string }> = [];
            // Record skip provenance once for the diagnostic even when some
            // members succeed, so partial syncs also show what was excluded.
            this.lastSyntheticLegSyncSkip = null;

            for (const member of members) {
                const resolution = this.resolveWorkerSyntheticPairWithSource(member, members);
                const syntheticPair = resolution.pair;
                if (!syntheticPair) {
                    skippedMembers.push({
                        streamId: member.stream_id,
                        symbol: member.symbol,
                        reason: resolution.reason ?? "no synthetic pair resolvable",
                    });
                    continue;
                }
                if (!matchesSyntheticSymbol(member.symbol, syntheticPair)) {
                    skippedMembers.push({
                        streamId: member.stream_id,
                        symbol: member.symbol,
                        reason: `resolved pair ${syntheticPair.baseSymbol}/${syntheticPair.quoteSymbol} does not match member symbol ${member.symbol}`,
                    });
                    continue;
                }

                const source = pickSourceInterval(member.interval);
                const sourceInterval = source?.sourceInterval ?? member.interval;
                const targetBars = Math.max(
                    SYNTHETIC_WORKER_CANDLE_LIMIT,
                    Math.floor(member.candle_limit || 0)
                );
                const sourceBars = Math.max(
                    SYNTHETIC_COMMITTEE_SYNC_MIN_SOURCE_BARS,
                    resolveSyntheticSourceBars(targetBars, source?.ratio ?? 1)
                );
                const key = [
                    syntheticPair.baseSymbol,
                    syntheticPair.quoteSymbol,
                    sourceInterval,
                ].join("|");
                const existing = plans.get(key);
                if (existing) {
                    existing.sourceBars = Math.max(existing.sourceBars, sourceBars);
                    existing.members.push({ streamId: member.stream_id, interval: member.interval, targetBars });
                    continue;
                }
                plans.set(key, {
                    baseSymbol: syntheticPair.baseSymbol,
                    quoteSymbol: syntheticPair.quoteSymbol,
                    sourceInterval,
                    sourceBars,
                    members: [{ streamId: member.stream_id, interval: member.interval, targetBars }],
                });
            }

            if (plans.size === 0) {
                // No member could be planned. Distinguish "nothing enabled"
                // from "members exist but their synthetic pair couldn't be
                // resolved" — the latter is the common, fixable case (load the
                // synthetic chart so the `chart` resolution branch matches).
                const skipSnapshot = {
                    at: new Date().toISOString(),
                    activeMemberCount: members.length,
                    skipped: skippedMembers,
                };
                this.lastSyntheticLegSyncSkip = skipSnapshot;
                if (skippedMembers.length === 0) {
                    uiManager.showToast(
                        "No synthetic committee members to sync. Add a synthetic chart member or enable existing ones.",
                        "info"
                    );
                    dom.signalCommitteeStatus.textContent =
                        "No active synthetic members to sync.";
                } else {
                    uiManager.showToast(
                        `No synthetic members could be planned. ${skippedMembers.length} skipped — see diagnostic. Example: ${skippedMembers[0].reason}`,
                        "warning"
                    );
                    dom.signalCommitteeStatus.textContent =
                        `Sync skipped ${skippedMembers.length} member${skippedMembers.length === 1 ? "" : "s"} (open the diagnostic for reasons). Most common fix: load the synthetic chart so its pair is in scope.`;
                    debugLogger.warn("signal_committee.synthetic_leg_sync_all_skipped", skipSnapshot);
                }
                return;
            }
            // Some members planned (possibly with others skipped). Record the
            // skips for the diagnostic pane so partial syncs are explainable.
            if (skippedMembers.length > 0) {
                this.lastSyntheticLegSyncSkip = {
                    at: new Date().toISOString(),
                    activeMemberCount: members.length,
                    skipped: skippedMembers,
                };
            }

            let storedLegs = 0;
            let evaluatedMembers = 0;
            let stillBinanceBlocked = false;
            for (const plan of plans.values()) {
                dom.signalCommitteeStatus.textContent =
                    `Syncing ${plan.baseSymbol}/${plan.quoteSymbol} ${plan.sourceInterval} (${plan.sourceBars.toLocaleString()} bars)...`;
                const [baseData, quoteData] = await Promise.all([
                    dataManager.fetchHistoricalData(plan.baseSymbol, plan.sourceInterval, plan.sourceBars),
                    dataManager.fetchHistoricalData(plan.quoteSymbol, plan.sourceInterval, plan.sourceBars),
                ]);
                const legs = [
                    { symbol: plan.baseSymbol, data: baseData },
                    { symbol: plan.quoteSymbol, data: quoteData },
                ];
                for (const leg of legs) {
                    if (leg.data.length === 0) {
                        throw new Error(`No Binance candles returned for ${leg.symbol} ${plan.sourceInterval}.`);
                    }
                    const stored = await storeSqliteCandles(
                        leg.symbol,
                        plan.sourceInterval,
                        leg.data,
                        "Binance",
                        "signal-committee-sync"
                    );
                    if (!stored?.ok) {
                        throw new Error(stored?.error || `Failed to store ${leg.symbol} ${plan.sourceInterval} in SQLite.`);
                    }
                    dataManager.invalidateCacheEntry(leg.symbol, plan.sourceInterval);
                    storedLegs += 1;
                }
                const dataset = buildSyntheticPairDataset({
                    base: baseData,
                    quote: quoteData,
                    interval: plan.sourceInterval,
                    minBars: 1,
                });
                for (const member of plan.members) {
                    const source = pickSourceInterval(member.interval);
                    const bars = source
                        ? aggregateSyntheticBars(dataset.bars, member.interval)
                        : dataset.bars;
                    const candles = bars.slice(-Math.max(1, member.targetBars));
                    if (candles.length === 0) {
                        throw new Error(`No synthetic candles built for ${member.streamId}.`);
                    }
                    const run = await alertService.runWithCandles(member.streamId, candles, true);
                    if (run.status.includes("Binance API unavailable")) {
                        stillBinanceBlocked = true;
                    }
                    evaluatedMembers += 1;
                }
            }

            uiManager.showToast(
                stillBinanceBlocked
                    ? `Synced ${storedLegs} leg series, but at least one member still hit Binance fetch.`
                    : `Synced ${storedLegs} leg series and evaluated ${evaluatedMembers} members from local synthetic candles.`,
                stillBinanceBlocked ? "warning" : "success"
            );
            await this.refresh({ manual: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.error("signal_committee.synthetic_leg_sync_failed", { error: message });
            uiManager.showToast(`Synthetic leg sync failed: ${message}`, "error");
            dom.signalCommitteeStatus.textContent = `Synthetic leg sync failed: ${message}`;
        } finally {
            dom.signalCommitteeSyncSyntheticBtn.disabled = false;
            dom.signalCommitteeSyncSyntheticBtn.textContent = originalText;
        }
    }

    private resolveWorkerSyntheticPair(
        member: AlertSubscription,
        siblings: readonly AlertSubscription[] = []
    ): { baseSymbol: string; quoteSymbol: string } | null {
        return this.resolveWorkerSyntheticPairWithSource(member, siblings).pair;
    }

    /**
     * Same resolution as {@link resolveWorkerSyntheticPair}, but returns which
     * source supplied the pair (or why none did). Used by `syncSyntheticLegs`
     * to surface actionable skip reasons instead of a generic "nothing to sync"
     * — the failure modes below are the real reasons a synthetic member can't
     * be synced, and each has a distinct user fix.
     *
     * Resolution order (first non-null wins):
     *   1. `stored`   — pair embedded in the worker row's `backtest_settings_json`
     *   2. `chart`    — the currently loaded chart is this pair (populates via
     *                   `getSyntheticPairMetadata`), and the member's symbol matches
     *   3. `config`   — the member's saved StrategyConfig carries `syntheticPair`
     *   4. `sibling`  — another committee member on the same synthetic symbol
     *                   already has a stored pair. This recovers members that were
     *                   added without persisting a pair (legacy rows) without the
     *                   user needing to load the synthetic chart first. The
     *                   sibling's pair must derive to the member's symbol, so a
     *                   ZECUSDT/APTUSDT sibling only reuses for ZECAPT members.
     *
     * `reason` is populated only when `pair === null` and names the most
     * informative available signal about why resolution failed. A chart-member
     * mismatch does NOT short-circuit resolution: the member may still resolve
     * via `config` or `sibling` (e.g. an APTZEC member while the ZECAPT chart
     * is open). It is recorded as a candidate reason used only if every source
     * ultimately fails.
     *
     * @param siblings optional committee member list for the `sibling` fallback.
     *   Callers that already have the member list in hand (sync, repair, legs)
     *   pass it so legacy rows recover automatically. Omit to skip that branch.
     */
    private resolveWorkerSyntheticPairWithSource(
        member: AlertSubscription,
        siblings: readonly AlertSubscription[] = []
    ): { pair: { baseSymbol: string; quoteSymbol: string } | null; source: "stored" | "chart" | "config" | "sibling" | null; reason: string | null } {
        const storedPair = readSyntheticPairFromSettingsJson(member.backtest_settings_json);
        if (storedPair) return { pair: storedPair, source: "stored", reason: null };

        // Candidate reason if every source ultimately fails. Recorded early so
        // the chart-vs-member mismatch shows up in diagnostics, but it never
        // short-circuits: a member whose symbol differs from the open chart can
        // still resolve via config or a sibling (e.g. an APTZEC member while the
        // ZECAPT chart is open).
        let bestReason: string | null = null;

        const currentPair = getSyntheticPairMetadata();
        if (currentPair && matchesSyntheticSymbol(state.currentSymbol, currentPair)) {
            if (matchesSyntheticSymbol(member.symbol, currentPair)) {
                return { pair: currentPair, source: "chart", reason: null };
            }
            bestReason = `chart pair is ${currentPair.baseSymbol}/${currentPair.quoteSymbol} but member symbol is ${member.symbol}`;
        }

        const configName = parseAlertConfigNameFromStreamId(member.stream_id);
        const config = configName ? settingsManager.loadStrategyConfig(configName) : null;
        const configPair = config?.syntheticPair ?? null;
        if (configPair) return { pair: configPair, source: "config", reason: null };

        // Sibling fallback: reuse a stored pair from any other member whose
        // stored pair derives to this member's synthetic symbol. Unambiguous
        // because it keys off a real stored pair + the existing
        // `matchesSyntheticSymbol` derivation, never off string-splitting the
        // member symbol itself.
        if (siblings.length > 0) {
            for (const sibling of siblings) {
                if (sibling === member) continue;
                const siblingPair = readSyntheticPairFromSettingsJson(sibling.backtest_settings_json);
                if (siblingPair && matchesSyntheticSymbol(member.symbol, siblingPair)) {
                    return { pair: siblingPair, source: "sibling", reason: null };
                }
            }
        }

        // All sources empty. Prefer the chart-mismatch reason (the most
        // actionable: "the open chart is a different pair") when available;
        // otherwise name the missing sources.
        const fallbackReason = bestReason ?? (configName
            ? `no synthetic pair in stored settings, loaded chart, or saved config "${configName}"`
            : "no synthetic pair in stored settings and no synthetic chart loaded");
        return { pair: null, source: null, reason: fallbackReason };
    }

    private async repairWorkerSyntheticSubscriptions(
        members: readonly AlertSubscription[]
    ): Promise<Array<{
        streamId: string;
        syntheticPair: { baseSymbol: string; quoteSymbol: string };
        status: string;
        candleLimit: number;
        strategyKey: string;
        streamStrategyKey: string | null;
        storedStrategyKey: string;
        error?: string;
    }>> {
        const repairs: Array<{
            streamId: string;
            syntheticPair: { baseSymbol: string; quoteSymbol: string };
            status: string;
            candleLimit: number;
            strategyKey: string;
            streamStrategyKey: string | null;
            storedStrategyKey: string;
            error?: string;
        }> = [];
        // One bulk config snapshot for the whole repair pass; previously each
        // iteration called loadStrategyConfig (which re-reads + re-parses the
        // entire persisted blob).
        const configNames = new Set<string>();
        for (const member of members) {
            const name = parseAlertConfigNameFromStreamId(member.stream_id);
            if (name) configNames.add(name);
        }
        const configByName = settingsManager.loadStrategyConfigsByName(configNames);
        for (const member of members) {
            const configName = parseAlertConfigNameFromStreamId(member.stream_id);
            const config = configName ? (configByName.get(configName) ?? null) : null;
            const streamStrategyKey = parseStrategyKeyFromStreamId(member.stream_id);
            const existingPair = readSyntheticPairFromSettingsJson(member.backtest_settings_json);
            const syntheticPair = existingPair ?? config?.syntheticPair ?? this.resolveWorkerSyntheticPair(member, members);
            if (!syntheticPair || !matchesSyntheticSymbol(member.symbol, syntheticPair)) continue;
            const strategyKey = config?.strategyKey ?? streamStrategyKey ?? member.strategy_key;
            const strategyParams = config?.strategyParams ?? parseStrategyParamsJson(member.strategy_params_json);
            const nextCandleLimit = Math.max(SYNTHETIC_WORKER_CANDLE_LIMIT, member.candle_limit || 0);
            const needsSyntheticPairRepair = !existingPair;
            const needsCandleLimitRepair = member.candle_limit < nextCandleLimit;
            const needsStrategyRepair = strategyKey !== member.strategy_key;
            const needsParamRepair = config !== null
                && JSON.stringify(config.strategyParams ?? {}) !== JSON.stringify(parseStrategyParamsJson(member.strategy_params_json));
            if (!needsSyntheticPairRepair && !needsCandleLimitRepair && !needsStrategyRepair && !needsParamRepair) continue;

            const backtestSettings = {
                ...((config?.backtestSettings as unknown as Record<string, unknown> | undefined)
                    ?? parseJsonRecord(member.backtest_settings_json)),
                syntheticPair,
            };
            try {
                await alertService.upsertSubscription({
                    streamId: member.stream_id,
                    symbol: member.symbol,
                    interval: member.interval,
                    strategyKey,
                    configName: configName ?? undefined,
                    strategyParams,
                    backtestSettings,
                    freshnessBars: member.freshness_bars,
                    notifyTelegram: member.notify_telegram === 1,
                    notifyExit: member.notify_exit === 1,
                    enabled: member.enabled === 1,
                    candleLimit: nextCandleLimit,
                    committeeTag: member.committee_tag ?? DEFAULT_COMMITTEE_TAG,
                });
                repairs.push({
                    streamId: member.stream_id,
                    syntheticPair,
                    status: [
                        needsSyntheticPairRepair ? "synthetic_pair" : null,
                        needsCandleLimitRepair ? "candle_limit" : null,
                        needsStrategyRepair ? "strategy_key" : null,
                        needsParamRepair ? "strategy_params" : null,
                    ].filter(Boolean).join("+") || "repaired",
                    candleLimit: nextCandleLimit,
                    strategyKey,
                    streamStrategyKey,
                    storedStrategyKey: member.strategy_key,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                repairs.push({
                    streamId: member.stream_id,
                    syntheticPair,
                    status: "error",
                    candleLimit: nextCandleLimit,
                    strategyKey,
                    streamStrategyKey,
                    storedStrategyKey: member.strategy_key,
                    error: message,
                });
                debugLogger.warn("signal_committee.worker_subscription_repair_failed", {
                    streamId: member.stream_id,
                    error: message,
                });
            }
        }
        return repairs;
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
        dom.signalCommitteeAddSavedBtn.addEventListener("click", () => {
            void this.addSavedConfigurationsForCurrentChart();
        });
        dom.signalCommitteeBulkPairsBtn.addEventListener("click", () => {
            // Open the collapsed bulk-pairs panel and focus the textarea so the
            // user has an obvious entry point from the toolbar. The panel stays
            // collapsed by default to avoid crowding the tab on first load.
            const details = dom.signalCommitteeBulkPairs.closest("details");
            if (details && !details.open) details.open = true;
            dom.signalCommitteeBulkPairs.focus();
        });
        dom.signalCommitteeBulkAddBtn.addEventListener("click", () => {
            void this.addBulkPairsFromTextarea();
        });
        dom.signalCommitteeBulkDeleteBtn.addEventListener("click", () => {
            void this.bulkDeleteSelected();
        });
        dom.signalCommitteeSelectAll.addEventListener("change", () => {
            // Master toggle: set every row checkbox to match the header checkbox,
            // then sync the delete-button label. Row checkboxes are re-read from
            // the DOM (rows are re-rendered on refresh, so a JS-side selection
            // set would desync; DOM is the source of truth for selection).
            const checked = dom.signalCommitteeSelectAll.checked;
            dom.signalCommitteeTableBody
                .querySelectorAll<HTMLInputElement>("input[type=\"checkbox\"][data-signal-committee-select]")
                .forEach((cb) => { cb.checked = checked; });
            this.syncBulkDeleteButton();
        });
        // Row checkbox changes: re-derive select-all state + button label.
        // `change` (not `click`) because checkboxes toggle on keyboard too.
        dom.signalCommitteeTableBody.addEventListener("change", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (!target.dataset.signalCommitteeSelect) return;
            this.syncBulkDeleteButton();
            this.syncSelectAllCheckbox();
        });
        dom.signalCommitteeSyncSyntheticBtn.addEventListener("click", () => {
            void this.syncSyntheticLegs();
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
            // Cycle off -> current -> historical -> off via the ordered tuple,
            // so adding a future mode can't silently break the rotation.
            const currentIndex = COMMITTEE_OVERLAY_MODES.indexOf(this.overlayMode);
            const nextIndex = (currentIndex + 1) % COMMITTEE_OVERLAY_MODES.length;
            const next = COMMITTEE_OVERLAY_MODES[nextIndex];
            this.overlayMode = next;
            dom.signalCommitteeChartToggleBtn.textContent = COMMITTEE_OVERLAY_BUTTON_LABEL[next];
            if (next === "off") {
                chartManager.removeCommitteeScoreOverlay();
                this.clearScoreEdge();
            } else {
                this.renderScoreOverlay();
            }
        });
        dom.signalCommitteeAlertSaveBtn.addEventListener("click", () => {
            void this.saveAlertRule();
        });
        dom.signalCommitteeScoreEdgeCopyBtn.addEventListener("click", () => {
            void this.copyScoreEdgeExport();
        });
        dom.signalCommitteeTableBody.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const loadStream = target.dataset.signalCommitteeLoad;
            const removeStream = target.dataset.signalCommitteeRemove;
            const toggleSpec = target.dataset.signalCommitteeToggleEnabled;
            if (loadStream) {
                void this.loadConfiguration(loadStream);
            } else if (removeStream) {
                void this.removeConfiguration(removeStream);
            } else if (toggleSpec) {
                // Encoded as `{0|1}:{streamId}` — the desired NEXT enabled
                // state, so we don't have to re-derive it from cached state.
                const sep = toggleSpec.indexOf(":");
                const wantEnabled = sep > 0 && toggleSpec.slice(0, sep) === "1";
                const streamId = sep > 0 ? toggleSpec.slice(sep + 1) : "";
                if (streamId) void this.setMemberEnabled(streamId, wantEnabled);
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

        // Render the diagnostic snapshot lazily — only when the user actually
        // expands the <details>. renderDiagnostic skips work while it stays
        // collapsed, so auto-refresh doesn't pay the stringify + reflow cost.
        const diagnosticDetails = dom.signalCommitteeDiagnosticPre?.closest("details");
        if (diagnosticDetails) {
            diagnosticDetails.addEventListener("toggle", () => {
                if (diagnosticDetails.open) this.renderDiagnostic();
            });
        }

        // Same lazy pattern for the Score Edge Report: recompute-on-refresh
        // stores the report; we only pay the innerHTML reflow when the user
        // opens the section.
        const scoreEdgeDetails = dom.signalCommitteeScoreEdgeBody?.closest("details");
        if (scoreEdgeDetails) {
            scoreEdgeDetails.addEventListener("toggle", () => {
                if (scoreEdgeDetails.open) this.renderScoreEdge();
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
        const pair = getSyntheticPairMetadata();
        return matchesSyntheticSymbol(state.currentSymbol, pair);
    }

    private getLocalSyntheticMemberRecords(): LocalSyntheticMemberRecord[] {
        // One snapshot of the persisted blob per refresh; previously this called
        // loadStrategyConfig (which re-reads + re-parses the whole blob) once
        // per local member, which compounded with auto-refresh.
        const storedMembers = readLocalSyntheticMembers();
        const configByName = settingsManager.loadStrategyConfigsByName(
            new Set(storedMembers.map((m) => m.configName))
        );
        return storedMembers.map((stored, index) => {
            const config = configByName.get(stored.configName) ?? null;
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
                    // Surface the local `disabled` flag as the standard
                    // `enabled` column so `isMemberActive` treats worker and
                    // local members uniformly.
                    enabled: stored.disabled ? 0 : 1,
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

    private async evaluateLocalSyntheticMembers(
        records: readonly LocalSyntheticMemberRecord[]
    ): Promise<Map<string, CommitteeMemberState>> {
        const states = new Map<string, CommitteeMemberState>();
        const currentPair = getSyntheticPairMetadata();
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
                        this.lastDiagnosticObj = diag;
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
            let workerMembers = this.workerReachable
                ? await alertService.listCommitteeSubscriptions()
                : [];
            const workerSubscriptionRepairs = this.workerReachable
                ? await this.repairWorkerSyntheticSubscriptions(workerMembers)
                : [];
            const repairedStreamIds = workerSubscriptionRepairs
                .filter((repair) => repair.status !== "error")
                .map((repair) => repair.streamId);
            if (workerSubscriptionRepairs.length > 0) {
                diag.workerSubscriptionRepairs = workerSubscriptionRepairs;
            }
            if (repairedStreamIds.length > 0) {
                workerMembers = await alertService.listCommitteeSubscriptions();
            }
            const localRecordStreamIds = new Set([
                ...localRecords.map((record) => record.subscription.stream_id),
            ]);
            const remoteWorkerMembers = workerMembers.filter((member) => !localRecordStreamIds.has(member.stream_id));
            // Parse each member's stream_id / settings JSON exactly once per
            // refresh and reuse the result across both diagnostic blocks
            // (listMembers and memberStates) instead of re-parsing 3-4 times.
            const memberDigestByStreamId = new Map<string, {
                syntheticPair: { baseSymbol: string; quoteSymbol: string } | null;
                streamStrategyKey: string | null;
            }>();
            for (const m of workerMembers) {
                memberDigestByStreamId.set(m.stream_id, {
                    syntheticPair: readSyntheticPairFromSettingsJson(m.backtest_settings_json),
                    streamStrategyKey: parseStrategyKeyFromStreamId(m.stream_id),
                });
            }
            diag.listCount = workerMembers.length;
            diag.listMembers = workerMembers.map((m) => {
                const digest = memberDigestByStreamId.get(m.stream_id);
                const syntheticPair = digest?.syntheticPair ?? null;
                const streamStrategyKey = digest?.streamStrategyKey ?? null;
                return {
                    stream_id: m.stream_id,
                    symbol: m.symbol,
                    interval: m.interval,
                    strategy_key: m.strategy_key,
                    stream_strategy_key: streamStrategyKey,
                    strategy_key_matches_stream: streamStrategyKey === m.strategy_key,
                    committee_tag: m.committee_tag ?? null,
                    enabled: m.enabled,
                    candle_limit: m.candle_limit,
                    syntheticPair,
                    hasSyntheticPair: Boolean(syntheticPair),
                    last_status: m.last_status,
                    last_run_at: m.last_run_at,
                };
            });
            diag.workerSyntheticFallbackMembers = [];
            this.members = [
                ...localRecords.map((record) => record.subscription),
                ...remoteWorkerMembers,
            ].slice(0, MEMBER_HARD_CAP);
            if (this.members.length === 0) {
                this.memberStates.clear();
                diag.stage = "no_members";
                this.lastDiagnosticObj = diag;
                this.renderDiagnostic();
                this.renderEmptyMembers();
                return;
            }

            // 3. Batched state read (with fallback handled inside alertService).
            // getCommitteeStateBatched chunks at COMMITTEE_STATE_BATCH_SIZE so
            // committees over 100 members still get state for every row — the
            // worker's getCommitteeState caps each request at MAX_BATCH=100.
            const streamIds = remoteWorkerMembers
                .slice(0, Math.max(0, MEMBER_HARD_CAP - localRecordStreamIds.size))
                .map((m) => m.stream_id);
            diag.batchedRequest = { streamIds };
            let result = await this.getCommitteeStateBatched(streamIds);
            diag.batchedResponse = {
                ok: result.ok,
                scanned: result.scanned,
                truncated: result.truncated,
                statesCount: result.states.length,
            };
            if (options.manual && repairedStreamIds.length > 0) {
                diag.workerSubscriptionRepairWarmup = await this.warmWorkerStateCache(repairedStreamIds);
                result = await this.getCommitteeStateBatched(streamIds);
                diag.batchedResponseAfterWorkerSubscriptionRepairWarmup = {
                    ok: result.ok,
                    scanned: result.scanned,
                    truncated: result.truncated,
                    statesCount: result.states.length,
                };
            }
            if (options.manual && streamIds.length > 0) {
                const missingCachedStreamIds = streamIds.filter((streamId) => {
                    const state = result.states.find((candidate) => candidate.streamId === streamId);
                    return !state || (!state.ok && state.reason === "no_cached_state");
                });
                if (missingCachedStreamIds.length > 0) {
                    diag.runNowWarmup = await this.warmWorkerStateCache(missingCachedStreamIds);
                    result = await this.getCommitteeStateBatched(streamIds);
                    diag.batchedResponseAfterWarmup = {
                        ok: result.ok,
                        scanned: result.scanned,
                        truncated: result.truncated,
                        statesCount: result.states.length,
                    };
                }
            }
            this.memberStates = new Map(localStates);
            for (const s of result.states) {
                this.memberStates.set(s.streamId, s);
            }
            // Diagnostic per-member state: shows exactly what the worker returned,
            // including the vote direction, isOpen, latestClose, tradeWindows.
            diag.memberStates = this.members.map((m) => {
                const s = this.memberStates.get(m.stream_id);
                if (!s) return { stream_id: m.stream_id, present: false };
                const latestChartCandle = state.ohlcvData[state.ohlcvData.length - 1] ?? null;
                const chartTrades = state.currentBacktestResult?.trades ?? [];
                const chartLastTrade = chartTrades[chartTrades.length - 1] ?? null;
                const chartEntryTimeSec = chartLastTrade ? this.candleToSec({ time: chartLastTrade.entryTime }) : null;
                const workerEntryTimeSec = s.latestTrade?.entryTimeSec ?? null;
                const chartLatestClose = latestChartCandle && Number.isFinite(latestChartCandle.close)
                    ? latestChartCandle.close
                    : null;
                // tradeWindows range — the key field for diagnosing "old bars
                // score 0". If `earliestSec` is recent (e.g. ~2 months ago on a
                // multi-year chart), the worker is sending a capped window and
                // needs redeploy; if `count` is small but `spanDays` is years,
                // the strategy itself fires few trades. Either way this number
                // localizes the cause without further instrumentation.
                const twRange = tradeWindowsRange(s.tradeWindows);
                return {
                    stream_id: m.stream_id,
                    ok: s.ok,
                    reason: s.reason,
                    direction: s.latestEntry?.direction ?? null,
                    isOpen: s.latestTrade?.isOpen ?? null,
                    entryTimeSec: s.latestTrade?.entryTimeSec ?? null,
                    entryPrice: s.latestTrade?.entryPrice ?? null,
                    latestClose: s.latestClose,
                    tradeWindowsCount: twRange.count,
                    tradeWindowsRange: twRange.range,
                    lastStatus: s.lastStatus,
                    workerSource: memberDigestByStreamId.get(m.stream_id)?.syntheticPair
                        ? "worker synthetic"
                        : "worker market",
                    chartComparison: {
                        chartSymbol: state.currentSymbol,
                        chartInterval: state.currentInterval,
                        chartBars: state.ohlcvData.length,
                        chartLatestClose,
                        latestCloseDelta: chartLatestClose !== null && s.latestClose !== null
                            ? s.latestClose - chartLatestClose
                            : null,
                        chartLastTrade: chartLastTrade
                            ? {
                                type: chartLastTrade.type,
                                entryTimeSec: chartEntryTimeSec,
                                entryPrice: chartLastTrade.entryPrice,
                                exitReason: chartLastTrade.exitReason ?? null,
                            }
                            : null,
                        workerVsChartEntryTimeDeltaSec: workerEntryTimeSec !== null && chartEntryTimeSec !== null
                            ? workerEntryTimeSec - chartEntryTimeSec
                            : null,
                        workerVsChartEntryPriceDelta: chartLastTrade && s.latestTrade?.entryPrice != null
                            ? s.latestTrade.entryPrice - chartLastTrade.entryPrice
                            : null,
                    },
                };
            });
            this.latestStatesAtIso = new Date().toISOString();
            diag.stage = "rendered";
            // Surface the latest "Sync Synthetic Legs" skip report so the user
            // can diagnose future sync failures (e.g. a member whose synthetic
            // pair couldn't be resolved) from the same diagnostic pane.
            if (this.lastSyntheticLegSyncSkip) {
                diag.lastSyntheticLegSyncSkip = this.lastSyntheticLegSyncSkip;
            }

            this.renderMembers();
            this.warnStaleCronIfAny();
            this.lastDiagnosticObj = diag;
            this.renderDiagnostic();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diag.stage = "exception";
            diag.error = message;
            this.lastDiagnosticObj = diag;
            this.renderDiagnostic();
            debugLogger.error("signal_committee.refresh_failed", { error: message });
            uiManager.showToast(`Committee refresh failed: ${message}`, "error");
        } finally {
            this.refreshInFlight = false;
        }
    }

    private renderDiagnostic(): void {
        const dom = this.getDom();
        if (!dom.signalCommitteeDiagnosticPre) return;
        // Skip the stringify + reflow when the diagnostic <details> is collapsed.
        // The toggle listener (see bindDomEvents) re-runs this on open so the
        // latest snapshot appears the moment the user expands it.
        const details = dom.signalCommitteeDiagnosticPre.closest("details");
        if (details && !details.open) return;
        dom.signalCommitteeDiagnosticPre.textContent = this.lastDiagnosticObj
            ? JSON.stringify(this.lastDiagnosticObj, null, 2)
            : "(no diagnostic yet)";
    }

    /**
     * Render the committee-score chart overlay in the current mode.
     *
     * The overlay is a thin set of wick markers on the main candlestick series,
     * not a histogram band. Markers carry the numeric net vote as their label
     * so the verdict reads directly on the chart.
     *
     * "historical" stamps one marker per bar where the reconstructed per-bar
     * vote changes (plus the latest bar), so flips in the committee verdict
     * are visible across the whole chart (e.g. +3 a day ago, +2 recently)
     * without stamping a number on every bar.
     *
     * If the worker has not yet populated `tradeWindows`, "historical" mode
     * renders nothing (overlay cleared) rather than misleading the user with
     * an all-zero marker on every bar.
     */
    private renderScoreOverlay(): void {
        if (this.overlayMode === "off") {
            this.clearScoreEdge();
            return;
        }
        if (this.members.length === 0 || this.memberStates.size === 0) {
            chartManager.removeCommitteeScoreOverlay();
            this.clearScoreEdge();
            return;
        }

        // Build the per-bar score series from ACTIVE members whose symbol (or
        // synthetic leg) matches the chart symbol. Without this scope, the
        // overlay would sum votes from every committee member — including
        // unrelated pairs — and the FETUSDT chart would read a score inflated
        // by every BTCUSDT / ETHUSDT / synthetic member. The badge in the
        // committee header intentionally sums the whole committee; the chart
        // overlay must NOT, because the chart is on one specific symbol.
        //
        // Resolution matches the per-leg leaderboard (`aggregateLegScores`):
        //   - direct member whose symbol is the chart symbol -> +1
        //   - synthetic member whose base leg is the chart symbol -> +1
        //     (long BASE/QUOTE is long BASE)
        //   - synthetic member whose quote leg is the chart symbol -> -1
        //     (long BASE/QUOTE is short QUOTE)
        // The multiplier is applied to every dirSign in the member's
        // tradeWindows inside `computeCommitteeOverlayScores`, so cross-pair
        // decomposition is consistent between the overlay and the leg board.
        const chartSymbol = state.currentSymbol;
        const overlayMembers = this.members
            .filter((m) => this.isMemberActive(m))
            .map((m) => {
                const s = this.memberStates.get(m.stream_id);
                const syntheticPair = this.resolveWorkerSyntheticPair(m, this.members);
                return {
                    streamId: m.stream_id,
                    tradeWindows: Array.isArray(s?.tradeWindows) ? s!.tradeWindows : null,
                    voteMultiplier: chartOverlayVoteMultiplier(chartSymbol, {
                        symbol: m.symbol,
                        syntheticPair: syntheticPair && matchesSyntheticSymbol(m.symbol, syntheticPair)
                            ? syntheticPair
                            : null,
                    }),
                };
            })
            .filter((m) => m.tradeWindows && m.tradeWindows.length > 0 && m.voteMultiplier !== 0);
        // The filter above guarantees every surviving overlayMembers entry has
        // non-empty tradeWindows and a non-zero multiplier, so an empty list
        // means no committee member matches this chart symbol. Clear rather
        // than show a misleading flat-zero marker that would imply the
        // committee is neutral on this symbol.
        if (overlayMembers.length === 0) {
            chartManager.removeCommitteeScoreOverlay();
            this.clearScoreEdge();
            return;
        }
        const bars = state.ohlcvData.map((candle) => ({ candle, sec: this.candleToSec(candle) }));
        const scores = computeCommitteeOverlayScores(bars, overlayMembers);
        const points = pickScoreChangePoints(bars, scores as unknown as ReadonlyArray<number>, (b) => {
            // Lightweight-charts accepts the bar's original time value.
            return b.candle.time as unknown as import("lightweight-charts").Time;
        });
        chartManager.setCommitteeScoreOverlay(points as Array<{ time: import("lightweight-charts").Time; value: number }>);

        // Rebuild the deterministic edge report from the same per-bar scores.
        // Computation is cheap (single pass + small Sharpe); rendering is gated
        // on the section being open (see renderScoreEdge).
        this.lastScoreEdgeReport = computeScoreEdgeReport(
            state.ohlcvData,
            scores as unknown as ReadonlyArray<number>,
            state.currentSymbol,
            state.currentInterval
        );
        this.renderScoreEdge();
    }

    /**
     * Render the Score Edge Report body, but only when its `<details>` is open.
     * The report is recomputed on every refresh; this gate avoids paying the
     * innerHTML reflow on every auto-refresh tick when the section is closed.
     */
    private renderScoreEdge(): void {
        const dom = this.getDom();
        if (!dom.signalCommitteeScoreEdgeBody) return;
        const details = dom.signalCommitteeScoreEdgeBody.closest("details");
        if (details && !details.open) return;
        const html = renderScoreEdgeReport(this.lastScoreEdgeReport);
        dom.signalCommitteeScoreEdgeBody.innerHTML = html
            || '<span class="signal-committee__edge-empty">Enable “Show Score on Chart” and refresh — the report rebuilds from the historical committee score on the loaded bars.</span>';
    }

    /** Clear the cached edge report and reset the section to its placeholder. */
    private clearScoreEdge(): void {
        this.lastScoreEdgeReport = null;
        const dom = this.getDom();
        if (!dom.signalCommitteeScoreEdgeBody) return;
        const details = dom.signalCommitteeScoreEdgeBody.closest("details");
        if (details && !details.open) return;
        dom.signalCommitteeScoreEdgeBody.innerHTML =
            '<span class="signal-committee__edge-empty">Enable “Show Score on Chart” and refresh — the report rebuilds from the historical committee score on the loaded bars.</span>';
    }

    private async copyScoreEdgeExport(): Promise<void> {
        if (!this.lastScoreEdgeReport) {
            uiManager.showToast("No score edge report yet. Enable historical overlay and refresh first.", "info");
            return;
        }
        const text = formatScoreEdgeAiExport(this.lastScoreEdgeReport);
        try {
            const copied = await copyToClipboard(text);
            if (!copied) throw new Error("Clipboard copy returned false");
            uiManager.showToast("Score edge AI export copied.", "success");
        } catch {
            uiManager.showToast("Copy failed.", "error");
        }
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
        // Staleness should only be assessed against ENABLED worker members.
        // Disabled members are never evaluated by the cron by design, so their
        // last_run_at is permanently stale; including them would surface a
        // false "verify cron triggers" warning whenever any member is paused —
        // even when the cron is healthy and every active member is fresh.
        const workerMembers = this.members.filter(
            (m) => !isLocalSyntheticStreamId(m.stream_id) && this.isMemberActive(m)
        );
        // localCount is local-synthetic members (any enabled state), computed
        // independently of the enabled-worker filter above so it isn't inflated
        // by disabled worker members.
        const localCount = this.members.filter((m) => isLocalSyntheticStreamId(m.stream_id)).length;
        const anyStale = workerMembers.some((m) => {
            const runAtMs = m.last_run_at ? Date.parse(m.last_run_at) : NaN;
            if (!Number.isFinite(runAtMs)) return true;
            return nowSec - Math.floor(runAtMs / 1000) > HEALTH_STALE_RUN_AT_SEC;
        });
        const dom = this.getDom();
        if (anyStale && this.workerReachable) {
            dom.signalCommitteeStatus.textContent =
                "Worker reachable but at least one active member has not been evaluated recently. Verify cron triggers are set.";
        } else if (this.workerReachable) {
            dom.signalCommitteeStatus.textContent =
                `${this.members.length} member${this.members.length === 1 ? "" : "s"} on the committee${localCount > 0 ? ` (${localCount} local synthetic)` : ""}.`;
        } else if (localCount > 0) {
            dom.signalCommitteeStatus.textContent =
                `${localCount} local synthetic member${localCount === 1 ? "" : "s"} evaluated from the loaded chart. Worker-backed members are unavailable.`;
        }
    }

    private resolveSyntheticPairForConfig(config: StrategyConfig): { baseSymbol: string; quoteSymbol: string } | null {
        if (config.syntheticPair) return config.syntheticPair;
        const currentPair = getSyntheticPairMetadata();
        const configSymbol = config.symbol ?? "";
        return matchesSyntheticSymbol(state.currentSymbol, currentPair)
            && configSymbol
            && matchesSyntheticSymbol(configSymbol, currentPair)
            ? currentPair
            : null;
    }

    private configMatchesCurrentChart(config: StrategyConfig): boolean {
        if (!isWorkerSupportedStrategyKey(config.strategyKey)) return false;
        if ((config.interval ?? "") !== state.currentInterval) return false;
        const configSymbol = config.symbol ?? "";
        if (!configSymbol) return false;
        if (symbolsMatch(configSymbol, state.currentSymbol)) return true;

        const currentPair = getSyntheticPairMetadata();
        return matchesSyntheticSymbol(state.currentSymbol, currentPair)
            && (
                matchesSyntheticSymbol(configSymbol, currentPair)
                || matchesSyntheticSymbol(configSymbol, config.syntheticPair ?? null)
            );
    }

    private async addSavedConfigurationsForCurrentChart(): Promise<void> {
        const configs = settingsManager.loadAllStrategyConfigs()
            .filter((config) => this.configMatchesCurrentChart(config));

        if (configs.length === 0) {
            uiManager.showToast("No saved configurations match the current chart and worker-supported strategies.", "info");
            return;
        }

        if (
            configs.length > 1
            && !window.confirm(`Add ${configs.length} saved configurations for ${state.currentSymbol} ${state.currentInterval} to the committee?`)
        ) {
            return;
        }

        // Fan out upserts in parallel. The worker persists each stream to its
        // own D1 row, so there is no cross-stream ordering dependency, and
        // warming all freshly-added streams in a single parallel batch at the
        // end avoids N sequential round trips.
        // Skip configs that are already committee members (same stream_id) so
        // the user gets feedback instead of a silent re-upsert of the same row.
        const allPlans = configs.map((config) => {
            const syntheticPair = this.resolveSyntheticPairForConfig(config);
            const symbol = config.symbol ?? state.currentSymbol;
            const interval = config.interval ?? state.currentInterval;
            const streamId = buildAlertStreamId(symbol, interval, config.strategyKey, config.name);
            return {
                config,
                syntheticPair,
                symbol,
                interval,
                streamId,
            };
        });
        const skippedAlreadyMembers = allPlans.filter((p) => this.isStreamIdAlreadyMember(p.streamId)).length;
        const plans = allPlans.filter((p) => !this.isStreamIdAlreadyMember(p.streamId));

        if (plans.length === 0) {
            uiManager.showToast(
                skippedAlreadyMembers > 0
                    ? `All ${skippedAlreadyMembers} matching config${skippedAlreadyMembers === 1 ? "" : "s"} already in the committee.`
                    : "No new saved configurations to add.",
                "info"
            );
            return;
        }

        const outcomes = await Promise.all(plans.map(async (plan) => {
            try {
                await alertService.upsertSubscription({
                    streamId: plan.streamId,
                    symbol: plan.symbol,
                    interval: plan.interval,
                    strategyKey: plan.config.strategyKey,
                    configName: plan.config.name,
                    strategyParams: plan.config.strategyParams,
                    backtestSettings: plan.syntheticPair
                        ? { ...plan.config.backtestSettings, syntheticPair: plan.syntheticPair }
                        : plan.config.backtestSettings,
                    freshnessBars: 1,
                    notifyTelegram: false,
                    enabled: true,
                    candleLimit: plan.syntheticPair ? SYNTHETIC_WORKER_CANDLE_LIMIT : undefined,
                    committeeTag: DEFAULT_COMMITTEE_TAG,
                });
                return { ok: true as const, streamId: plan.streamId, name: plan.config.name };
            } catch (error) {
                return {
                    ok: false as const,
                    name: plan.config.name,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }));

        const addedStreamIds = outcomes
            .filter((o): o is { ok: true; streamId: string; name: string } => o.ok)
            .map((o) => o.streamId);
        const failed = outcomes.filter((o) => !o.ok);
        const added = addedStreamIds.length;

        for (const failure of failed) {
            debugLogger.warn("signal_committee.bulk_add_failed", {
                name: failure.name,
                error: failure.error,
            });
        }

        if (addedStreamIds.length > 0) {
            await this.warmWorkerStateCache(addedStreamIds);
        }

        if (added > 0) {
            // Build a summary that surfaces skipped-already-members alongside
            // the added/failed counts so the user sees why N configs in the
            // list produced fewer than N new rows.
            const parts: string[] = [`Added ${added} saved configuration${added === 1 ? "" : "s"}`];
            if (skippedAlreadyMembers > 0) {
                parts.push(`${skippedAlreadyMembers} already member${skippedAlreadyMembers === 1 ? "" : "s"}`);
            }
            if (failed.length > 0) parts.push(`${failed.length} failed`);
            uiManager.showToast(parts.join("; "), failed.length > 0 ? "warning" : "success");
            await this.refresh({ manual: true });
            return;
        }

        uiManager.showToast(`Failed to add ${failed.length} saved configuration${failed.length === 1 ? "" : "s"}.`, "error");
    }

    /**
     * Bulk-add worker committee members from the textarea list. Each pair
     * becomes a voting member using the CURRENT strategy + params + backtest
     * settings + timeframe (mirrors {@link addCurrentConfiguration}, fanned
     * out across many symbols). Real symbols and synthetic tokens
     * (`BASE+QUOTE`) share the same parse path as Batch Backtest via
     * `parseBatchSymbols`, and synthetic members embed the same
     * `syntheticPair` metadata + `SYNTHETIC_WORKER_CANDLE_LIMIT` the single
     * Add path produces, so the worker treats them identically.
     */
    private async addBulkPairsFromTextarea(): Promise<void> {
        const dom = this.getDom();
        const strategyKey = state.currentStrategyKey.trim();
        if (!strategyKey) {
            uiManager.showToast("No strategy selected.", "warning");
            return;
        }
        if (!isWorkerSupportedStrategyKey(strategyKey)) {
            uiManager.showToast(
                "Signal Committee supports chart-data strategies only. Cross-symbol and 1s-Polymarket strategies are not supported here.",
                "warning"
            );
            return;
        }

        const context = resolveCurrentAlertSubscriptionContext();
        if (!context) {
            uiManager.showToast("No current chart context to add.", "error");
            return;
        }

        const pairs = parseBatchSymbols(dom.signalCommitteeBulkPairs.value);
        if (pairs.length === 0) {
            uiManager.showToast("No pairs entered. Paste one per line (e.g. BTCUSDT or ZEC+APT).", "info");
            return;
        }

        // Existing members occupy hard-cap slots already; only the remainder is
        // available for this bulk pass. Surface the truncation so the user
        // doesn't wonder why part of their list was silently dropped.
        const remaining = Math.max(0, MEMBER_HARD_CAP - this.members.length);
        let cappedPairs = pairs;
        if (pairs.length > remaining) {
            cappedPairs = pairs.slice(0, remaining);
            uiManager.showToast(
                `Committee is at the ${MEMBER_HARD_CAP}-member cap; only the first ${remaining} of ${pairs.length} pairs will be added.`,
                "warning"
            );
            if (remaining === 0) return;
        }

        // Pre-resolve each pair to its member symbol + synthetic metadata once,
        // so the upsert closure below is allocation-free. Synthetic pairs derive
        // a BASE+QUOTE symbol (e.g. ZEC+APT -> ZECAPT) and carry the legs in
        // backtestSettings, matching `addCurrentConfiguration`.
        const plans = cappedPairs.map((rawPair) => {
            const synth = parseSyntheticPairToken(rawPair);
            if (synth) {
                const memberSymbol = deriveSyntheticSymbol(synth.baseSymbol, synth.quoteSymbol);
                return {
                    rawPair,
                    memberSymbol,
                    syntheticPair: { baseSymbol: synth.baseSymbol, quoteSymbol: synth.quoteSymbol } as const,
                };
            }
            return { rawPair, memberSymbol: rawPair, syntheticPair: null } as const;
        });

        // Dedup at the streamId level — same config+TF+pair+strategy means the
        // same stream_id. Two flavors of duplicate:
        //   1. intra-list: the pasted text contained the same pair twice (the
        //      second is dropped from this pass)
        //   2. already-member: the committee already has this stream_id (the
        //      user explicitly wants a re-add rejected, not silently upserted)
        const seenStreamIds = new Set<string>();
        const existingMemberStreamIds = new Set<string>();
        const uniquePlans = plans.filter((plan) => {
            const streamId = buildAlertStreamId(
                plan.memberSymbol,
                context.interval,
                context.strategyKey,
                context.configName ?? undefined
            );
            if (seenStreamIds.has(streamId)) return false; // intra-list dup
            seenStreamIds.add(streamId);
            if (this.isStreamIdAlreadyMember(streamId)) {
                existingMemberStreamIds.add(streamId);
                return false;
            }
            return true;
        });
        const intraListDuplicates = plans.length - uniquePlans.length - existingMemberStreamIds.size;

        const outcomes = await Promise.all(uniquePlans.map(async (plan) => {
            const streamId = buildAlertStreamId(
                plan.memberSymbol,
                context.interval,
                context.strategyKey,
                context.configName ?? undefined
            );
            try {
                await alertService.upsertSubscription({
                    streamId,
                    symbol: plan.memberSymbol,
                    interval: context.interval,
                    strategyKey: context.strategyKey,
                    configName: context.configName ?? undefined,
                    strategyParams: context.strategyParams,
                    backtestSettings: plan.syntheticPair
                        ? { ...context.backtestSettings, syntheticPair: plan.syntheticPair }
                        : context.backtestSettings,
                    freshnessBars: 1,
                    notifyTelegram: false,
                    enabled: true,
                    candleLimit: plan.syntheticPair ? SYNTHETIC_WORKER_CANDLE_LIMIT : undefined,
                    committeeTag: DEFAULT_COMMITTEE_TAG,
                });
                return { ok: true as const, streamId, rawPair: plan.rawPair };
            } catch (error) {
                return {
                    ok: false as const,
                    rawPair: plan.rawPair,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }));

        const addedStreamIds = outcomes
            .filter((o): o is { ok: true; streamId: string; rawPair: string } => o.ok)
            .map((o) => o.streamId);
        const failed = outcomes.filter((o) => !o.ok);
        for (const failure of failed) {
            debugLogger.warn("signal_committee.bulk_pair_add_failed", {
                pair: failure.rawPair,
                error: failure.error,
            });
        }

        if (addedStreamIds.length > 0) {
            await this.warmWorkerStateCache(addedStreamIds);
        }
        // Build a summary that names every outcome so the user can see why the
        // added count doesn't match their pasted line count. Order: added,
        // already members, duplicates in list, failed.
        const parts: string[] = [`Added ${addedStreamIds.length} pair${addedStreamIds.length === 1 ? "" : "s"}`];
        if (existingMemberStreamIds.size > 0) {
            parts.push(`${existingMemberStreamIds.size} already member${existingMemberStreamIds.size === 1 ? "" : "s"}`);
        }
        if (intraListDuplicates > 0) {
            parts.push(`${intraListDuplicates} duplicate${intraListDuplicates === 1 ? "" : "s"} in list`);
        }
        if (failed.length > 0) {
            parts.push(`${failed.length} failed`);
        }
        const summary = parts.join("; ");
        const tone = failed.length > 0
            ? "warning"
            : addedStreamIds.length > 0 ? "success" : "info";

        if (addedStreamIds.length > 0) {
            uiManager.showToast(summary, tone);
            // Clear the textarea only when every unique new pair actually added
            // (failures or dups shouldn't wipe the input — the user may want to
            // retry or inspect what was skipped).
            if (failed.length === 0) dom.signalCommitteeBulkPairs.value = "";
            await this.refresh({ manual: true });
            return;
        }

        // Nothing added. Distinguish "all already members / duplicates" (info)
        // from genuine failures (error) so the user isn't told their already-
        // member pairs "failed".
        if (failed.length === 0) {
            uiManager.showToast(summary || "No new pairs to add.", "info");
        } else {
            uiManager.showToast(`Failed to add ${failed.length} pair${failed.length === 1 ? "" : "s"}.`, "error");
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
            const currentSyntheticPair = getSyntheticPairMetadata();
            const shouldUseSyntheticWorker =
                this.isCurrentSymbolSynthetic()
                || matchesSyntheticSymbol(state.currentSymbol, existingSyntheticPair);
            const syntheticPairForWorker = shouldUseSyntheticWorker
                ? savedConfig.syntheticPair ?? existingSyntheticPair ?? currentSyntheticPair
                : null;
            if (shouldUseSyntheticWorker && syntheticPairForWorker && !savedConfig.syntheticPair) {
                savedConfig = settingsManager.upsertStrategyConfig({
                    ...savedConfig,
                    syntheticPair: syntheticPairForWorker,
                });
            }
            const configName = context.configName ?? trimmed;
            const streamId = buildAlertStreamId(
                context.symbol,
                context.interval,
                context.strategyKey,
                configName
            );
            if (this.isStreamIdAlreadyMember(streamId)) {
                uiManager.showToast(`"${trimmed}" is already a member of the committee.`, "info");
                return;
            }
            await alertService.upsertSubscription({
                streamId,
                symbol: context.symbol,
                interval: context.interval,
                strategyKey: context.strategyKey,
                configName,
                strategyParams: context.strategyParams,
                backtestSettings: syntheticPairForWorker
                    ? { ...context.backtestSettings, syntheticPair: syntheticPairForWorker }
                    : context.backtestSettings,
                freshnessBars: 1,
                notifyTelegram: false,
                enabled: true,
                candleLimit: syntheticPairForWorker ? SYNTHETIC_WORKER_CANDLE_LIMIT : undefined,
                committeeTag: DEFAULT_COMMITTEE_TAG,
            });
            await this.warmWorkerStateCache([streamId]);
            uiManager.showToast(
                syntheticPairForWorker
                    ? `Added "${trimmed}" to the committee with worker synthetic-pair metadata.`
                    : `Added "${trimmed}" to the committee.`,
                "success"
            );
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

    /**
     * Update the bulk-delete button label and enabled state from the current
     * DOM selection. Called after every row-checkbox change and after every
     * render (selection is DOM-owned; see {@link bulkDeleteSelected}).
     */
    private syncBulkDeleteButton(): void {
        const dom = this.getDom();
        const checked = dom.signalCommitteeTableBody
            .querySelectorAll<HTMLInputElement>("input[type=\"checkbox\"][data-signal-committee-select]:checked");
        const count = checked.length;
        dom.signalCommitteeBulkDeleteBtn.disabled = count === 0;
        dom.signalCommitteeBulkDeleteBtn.textContent = `Delete Selected (${count})`;
    }

    /**
     * Reflect the per-row selection state into the header "select all"
     * checkbox: checked when every row is checked, unchecked when none are,
     * indeterminate for partial selection. Mirrors standard table UX.
     */
    private syncSelectAllCheckbox(): void {
        const dom = this.getDom();
        const rowCheckboxes = Array.from(dom.signalCommitteeTableBody
            .querySelectorAll<HTMLInputElement>("input[type=\"checkbox\"][data-signal-committee-select]"));
        if (rowCheckboxes.length === 0) {
            dom.signalCommitteeSelectAll.checked = false;
            dom.signalCommitteeSelectAll.indeterminate = false;
            return;
        }
        const checkedCount = rowCheckboxes.filter((cb) => cb.checked).length;
        dom.signalCommitteeSelectAll.checked = checkedCount === rowCheckboxes.length;
        dom.signalCommitteeSelectAll.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
    }

    /**
     * Bulk-delete every checked row. Partitions local-synthetic vs worker
     * members so local rows are removed in a single localStorage write and
     * worker rows fan out parallel `deleteSubscription` calls with per-row
     * error capture (same outcomes shape as {@link addBulkPairsFromTextarea}).
     */
    private async bulkDeleteSelected(): Promise<void> {
        const dom = this.getDom();
        const checked = Array.from(dom.signalCommitteeTableBody
            .querySelectorAll<HTMLInputElement>("input[type=\"checkbox\"][data-signal-committee-select]:checked"));
        const streamIds = checked
            .map((cb) => cb.dataset.signalCommitteeSelect)
            .filter((s): s is string => Boolean(s));
        if (streamIds.length === 0) return;

        if (!window.confirm(`Remove ${streamIds.length} member${streamIds.length === 1 ? "" : "s"} from the committee?`)) {
            return;
        }

        // Disable the button + clear checkboxes immediately so the user gets
        // visual confirmation even though worker deletes are async.
        dom.signalCommitteeBulkDeleteBtn.disabled = true;
        checked.forEach((cb) => { cb.checked = false; });
        dom.signalCommitteeSelectAll.checked = false;

        const localStreamIds = streamIds.filter((id) => isLocalSyntheticStreamId(id));
        const workerStreamIds = streamIds.filter((id) => !isLocalSyntheticStreamId(id));

        // Local members: one filtered write.
        if (localStreamIds.length > 0) {
            const localSet = new Set(localStreamIds);
            writeLocalSyntheticMembers(readLocalSyntheticMembers().filter((m) => !localSet.has(m.streamId)));
        }

        let failed = 0;
        if (workerStreamIds.length > 0) {
            const outcomes = await Promise.all(workerStreamIds.map(async (streamId) => {
                try {
                    await alertService.deleteSubscription(streamId, true);
                    return { ok: true as const, streamId };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("signal_committee.bulk_delete_failed", { streamId, error: message });
                    return { ok: false as const, streamId, error: message };
                }
            }));
            failed = outcomes.filter((o) => !o.ok).length;
        }

        const removed = streamIds.length - failed;
        if (failed > 0) {
            uiManager.showToast(`Removed ${removed}; ${failed} failed.`, "warning");
        } else {
            uiManager.showToast(`Removed ${removed} member${removed === 1 ? "" : "s"}.`, "success");
        }
        await this.refresh({ manual: true });
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
     * Toggle a member's active state without deleting it. A deactivated member
     * stops counting toward the committee score (filtered out of
     * `buildScoreRows`/`buildLegRows` via `isMemberActive`), stops being
     * re-evaluated by the worker cron, and is excluded from the worker's
     * committee Telegram alert. Re-enabling restores all three.
     *
     * Worker members flip the D1 `enabled` column via upsert; local-synthetic
     * members flip a `disabled` flag in the localStorage blob (they have no
     * D1 row). Both surfaces expose the result as `AlertSubscription.enabled`,
     * so `isMemberActive` treats them uniformly.
     */
    private async setMemberEnabled(streamId: string, enabled: boolean): Promise<void> {
        const configName = parseAlertConfigNameFromStreamId(streamId);
        const label = configName ?? streamId;
        try {
            if (isLocalSyntheticStreamId(streamId)) {
                writeLocalSyntheticMembers(readLocalSyntheticMembers().map((member) =>
                    member.streamId === streamId
                        ? { ...member, disabled: !enabled, updatedAt: new Date().toISOString() }
                        : member
                ));
            } else {
                await alertService.upsertSubscription({ streamId, enabled });
            }
            uiManager.showToast(`${enabled ? "Activated" : "Deactivated"} "${label}".`, "success");
            await this.refresh({ manual: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            uiManager.showToast(`Failed to toggle: ${message}`, "error");
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

    /**
     * Update the Score badge text + tone. Keeps `portfolio-lab__badge` for
     * sizing and swaps the tone class so positive/negative/neutral reads at
     * a glance. Mirrors the renderer's pure scoreTone output.
     */
    private setScoreBadge(text: string, tone: "positive" | "negative" | "neutral"): void {
        const badge = this.getDom().signalCommitteeScore;
        badge.textContent = text;
        badge.className = `portfolio-lab__badge signal-committee__score--${tone}`;
    }

    private buildScoreRows(): Array<CommitteeScoreRow & { voteDirection: "long" | "short" | null }> {
        const rows: Array<CommitteeScoreRow & { voteDirection: "long" | "short" | null }> = [];
        for (const m of this.members) {
            // Deactivated members are excluded from the score entirely — they
            // neither vote nor count as excluded-error. The score number, L/S
            // counts, and avg age/gain all reflect only active members.
            if (!this.isMemberActive(m)) continue;
            const s = this.memberStates.get(m.stream_id);
            if (!s || !s.ok) {
                rows.push({
                    streamId: m.stream_id,
                    ok: false,
                    latestTrade: null,
                    latestClose: null,
                    voteDirection: null,
                });
                continue;
            }
            const trade = s.latestTrade;
            const direction = s.latestEntry?.direction ?? null;
            rows.push({
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
            });
        }
        return rows;
    }

    /** A member counts toward the score iff it is enabled (worker `enabled=1`
     *  or local-synthetic `disabled=false` surfaced as `enabled`). */
    private isMemberActive(m: AlertSubscription): boolean {
        return m.enabled === 1;
    }

    /**
     * Membership test keyed on stream_id. Stream ids are deterministic from
     * (symbol+interval+strategyKey+configName), so an exact match here IS the
     * "same config + same timeframe + same pair" check. Used by every add path
     * to reject re-adding an existing member instead of silently upserting the
     * same D1 row (which is what the worker would otherwise do).
     *
     * Source of truth is the in-memory `this.members` cache, refreshed on
     * every `refresh()`. A member added in another browser tab won't be seen
     * until the next refresh — standard client-side cache limitation.
     */
    private isStreamIdAlreadyMember(streamId: string): boolean {
        return this.members.some((m) => m.stream_id === streamId);
    }

    /**
     * Build the per-leg score rows. Same vote logic as `buildScoreRows`, but
     * each row also carries the member's resolved synthetic pair so the
     * aggregator can decompose synthetic-pair votes into their two legs.
     *
     * Pair resolution delegates to `resolveWorkerSyntheticPair`, the same
     * canonical chain (`backtest_settings_json` → current-chart pair → saved
     * config) the rest of the service uses. The `matchesSyntheticSymbol` gate
     * mirrors `repairWorkerSyntheticSubscriptions`: a pair only counts when
     * the member's symbol actually is the derived synthetic, otherwise the
     * member is a real symbol and must not be decomposed.
     */
    private buildLegRows(): Array<LegScoreRow & { voteDirection: "long" | "short" | null }> {
        const rows: Array<LegScoreRow & { voteDirection: "long" | "short" | null }> = [];
        for (const m of this.members) {
            // Deactivated members are excluded from the leg leaderboard too —
            // a disabled synthetic pair must not decompose into leg votes.
            if (!this.isMemberActive(m)) continue;
            const s = this.memberStates.get(m.stream_id);
            const direction = s?.ok ? (s.latestEntry?.direction ?? null) : null;
            const trade = s?.latestTrade ?? null;
            const pair = this.resolveWorkerSyntheticPair(m, this.members);
            rows.push({
                streamId: m.stream_id,
                ok: Boolean(s?.ok),
                latestTrade: trade
                    ? {
                        entryTimeSec: trade.entryTimeSec,
                        entryPrice: trade.entryPrice,
                        isOpen: trade.isOpen,
                    }
                    : null,
                latestClose: s?.latestClose ?? null,
                voteDirection: direction,
                symbol: m.symbol,
                syntheticPair: pair && matchesSyntheticSymbol(m.symbol, pair) ? pair : null,
            });
        }
        return rows;
    }

    private renderLegBoard(rows: Array<LegScoreRow & { voteDirection: "long" | "short" | null }>): void {
        const dom = this.getDom();
        const legs = aggregateLegScores(rows);
        const html = renderLegLeaderboard(legs);
        dom.signalCommitteeLegLeaderboard.innerHTML = html
            || '<span class="signal-committee__leg-empty">No open trades yet.</span>';
    }

    private renderMembers(): void {
        const dom = this.getDom();
        const scoreRows = this.buildScoreRows();
        const nowSec = Math.floor(Date.now() / 1000);
        const aggregate: CommitteeAggregate = aggregateScore(scoreRows, nowSec);

        const header = renderCommitteeHeader(aggregate, this.latestStatesAtIso);
        this.setScoreBadge(header.score, header.scoreTone);
        dom.signalCommitteeLongShort.textContent = header.longShort;
        dom.signalCommitteeAvgAge.textContent = header.avgAge;
        dom.signalCommitteeAvgGain.textContent = header.avgGain;
        dom.signalCommitteeLastUpdated.textContent = header.lastUpdated;

        const views = this.members.map((m) => buildCommitteeRowView(
            m,
            this.memberStates.get(m.stream_id),
            nowSec,
            parseAlertConfigNameFromStreamId(m.stream_id)
        ));
        dom.signalCommitteeTableBody.innerHTML = renderCommitteeRows(views);
        // Rows were just replaced, so any prior checkbox selection is gone.
        // Reset the header checkbox and the bulk-delete button to a clean state.
        dom.signalCommitteeSelectAll.checked = false;
        this.syncBulkDeleteButton();

        this.renderLegBoard(this.buildLegRows());

        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";

        this.renderScoreOverlay();
    }

    private renderEmptyMembers(): void {
        const dom = this.getDom();
        this.setScoreBadge("—", "neutral");
        dom.signalCommitteeLongShort.textContent = "0L / 0S / 0Flat";
        dom.signalCommitteeAvgAge.textContent = "—";
        dom.signalCommitteeAvgGain.textContent = "—";
        dom.signalCommitteeLastUpdated.textContent = "—";
        dom.signalCommitteeStatus.textContent =
            "Worker connected. No committee members yet — click Add Current Configuration to start.";
        dom.signalCommitteeTableBody.innerHTML = renderCommitteeRows([]);
        dom.signalCommitteeLegLeaderboard.innerHTML =
            '<span class="signal-committee__leg-empty">No open trades yet.</span>';
        // Show the content (status bar + empty table) so the user sees the
        // real "connected, add a member" state. Hide the static pre-load
        // empty-state illustration.
        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";
        chartManager.removeCommitteeScoreOverlay();
        this.clearScoreEdge();
    }

    private renderHealthFail(message: string): void {
        const dom = this.getDom();
        this.setScoreBadge("—", "neutral");
        dom.signalCommitteeLongShort.textContent = "—";
        dom.signalCommitteeAvgAge.textContent = "—";
        dom.signalCommitteeAvgGain.textContent = "—";
        dom.signalCommitteeLastUpdated.textContent = "—";
        dom.signalCommitteeStatus.textContent = message;
        dom.signalCommitteeTableBody.innerHTML = renderEmptyHealthFail(message);
        dom.signalCommitteeLegLeaderboard.innerHTML =
            '<span class="signal-committee__leg-empty">No open trades yet.</span>';
        // Show content so the status bar + table (with the error message) are
        // visible. The static empty-state is for pre-load only.
        dom.signalCommitteeEmpty.style.display = "none";
        dom.signalCommitteeContent.style.display = "block";
        chartManager.removeCommitteeScoreOverlay();
        this.clearScoreEdge();
    }
}

export const signalCommitteeService = new SignalCommitteeService();
