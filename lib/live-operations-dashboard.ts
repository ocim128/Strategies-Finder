import { debugLogger } from "./debug-logger";
import { getOptionalElement } from "./dom-utils";

type JsonRecord = Record<string, unknown>;
type HealthState = "ok" | "warn" | "stale" | "unknown";

type ParsedSignal = {
    id: string;
    symbol: string;
    strategyKey: string;
    interval: string;
    side: "buy" | "sell" | "unknown";
    action: string;
    price: number | null;
    barTime: number | null;
    detectedAtIso: string | null;
    reason: string;
};

type ParsedSignalFeed = {
    generatedAtIso: string | null;
    cycleAtIso: string | null;
    pollSeconds: number;
    watchlistCount: number;
    signals: ParsedSignal[];
};

type LeaderboardRow = {
    symbol: string;
    strategyKey: string;
    robustScore: number;
    netProfitPercent: number;
    sharpeRatio: number;
    maxDrawdownPercent: number;
    drift: number;
    quoteVolume: number;
    winRatePercent: number | null;
    profitFactor: number | null;
    params: Record<string, number>;
};

type ParsedAlpha = {
    generatedAtIso: string | null;
    fetchedNow: number;
    reusedCached: number;
    rankedCount: number;
    rows: LeaderboardRow[];
};

type ParsedPaper = {
    generatedAtIso: string | null;
    cycleAtIso: string | null;
    pollSeconds: number;
    todayPnlUsd: number;
    totalEquityUsd: number;
    floatingPnlUsd: number;
    realizedPnlUsd: number;
    totalReturnPercent: number;
    totalTrades: number;
    winRatePercent: number;
    sourceStatus: string;
    positions: Array<{
        symbol: string;
        strategyKey: string;
        entryPrice: number;
        markPrice: number;
        floatingPnlUsd: number;
        entryTimeIso: string | null;
    }>;
};

const SIGNAL_POLL_MS = 5_000;
const ALPHA_POLL_MS = 15_000;
const PAPER_POLL_MS = 5_000;
const HEALTH_TICK_MS = 1_000;
const LOADER_WARN_MS = 4 * 60 * 60 * 1000;
const LOADER_STALE_MS = 12 * 60 * 60 * 1000;

class LiveOperationsDashboard {
    private initialized = false;
    private latestSignals: ParsedSignalFeed | null = null;
    private latestAlpha: ParsedAlpha | null = null;
    private latestPaper: ParsedPaper | null = null;
    private seenSignalIds = new Set<string>();
    private freshSignalExpiryById = new Map<string, number>();

    private signalTickerEl: HTMLElement | null = null;
    private signalMetaEl: HTMLElement | null = null;
    private leaderboardBodyEl: HTMLElement | null = null;
    private leaderboardMetaEl: HTMLElement | null = null;
    private ledgerMetaEl: HTMLElement | null = null;
    private todayPnlEl: HTMLElement | null = null;
    private todayPnlSubtextEl: HTMLElement | null = null;
    private totalEquityEl: HTMLElement | null = null;
    private totalEquitySubtextEl: HTMLElement | null = null;
    private activePositionsEl: HTMLElement | null = null;
    private activeFloatingEl: HTMLElement | null = null;
    private positionsBodyEl: HTMLElement | null = null;
    private healthMetaEl: HTMLElement | null = null;
    private overallHealthEl: HTMLElement | null = null;
    private overallHealthDotEl: HTMLElement | null = null;
    private overallHealthTextEl: HTMLElement | null = null;
    private loaderCardEl: HTMLElement | null = null;
    private loaderStateEl: HTMLElement | null = null;
    private loaderValueEl: HTMLElement | null = null;
    private loaderDetailEl: HTMLElement | null = null;
    private towerCardEl: HTMLElement | null = null;
    private towerStateEl: HTMLElement | null = null;
    private towerValueEl: HTMLElement | null = null;
    private towerDetailEl: HTMLElement | null = null;
    private paperCardEl: HTMLElement | null = null;
    private paperStateEl: HTMLElement | null = null;
    private paperValueEl: HTMLElement | null = null;
    private paperDetailEl: HTMLElement | null = null;

    public init(): void {
        if (this.initialized || !getOptionalElement("operationsTab")) return;
        this.initialized = true;

        this.signalTickerEl = getOptionalElement("opsSignalTicker");
        this.signalMetaEl = getOptionalElement("opsSignalFeedMeta");
        this.leaderboardBodyEl = getOptionalElement("opsLeaderboardBody");
        this.leaderboardMetaEl = getOptionalElement("opsLeaderboardMeta");
        this.ledgerMetaEl = getOptionalElement("opsLedgerMeta");
        this.todayPnlEl = getOptionalElement("opsTodayPnl");
        this.todayPnlSubtextEl = getOptionalElement("opsTodayPnlSubtext");
        this.totalEquityEl = getOptionalElement("opsTotalEquity");
        this.totalEquitySubtextEl = getOptionalElement("opsTotalEquitySubtext");
        this.activePositionsEl = getOptionalElement("opsActivePositions");
        this.activeFloatingEl = getOptionalElement("opsActiveFloating");
        this.positionsBodyEl = getOptionalElement("opsPositionsBody");
        this.healthMetaEl = getOptionalElement("opsHealthMeta");
        this.overallHealthEl = getOptionalElement("opsOverallHealth");
        this.overallHealthDotEl = getOptionalElement("opsOverallHealthDot");
        this.overallHealthTextEl = getOptionalElement("opsOverallHealthText");
        this.loaderCardEl = getOptionalElement("opsLoaderCard");
        this.loaderStateEl = getOptionalElement("opsLoaderState");
        this.loaderValueEl = getOptionalElement("opsLoaderValue");
        this.loaderDetailEl = getOptionalElement("opsLoaderDetail");
        this.towerCardEl = getOptionalElement("opsTowerCard");
        this.towerStateEl = getOptionalElement("opsTowerState");
        this.towerValueEl = getOptionalElement("opsTowerValue");
        this.towerDetailEl = getOptionalElement("opsTowerDetail");
        this.paperCardEl = getOptionalElement("opsPaperCard");
        this.paperStateEl = getOptionalElement("opsPaperState");
        this.paperValueEl = getOptionalElement("opsPaperValue");
        this.paperDetailEl = getOptionalElement("opsPaperDetail");

        this.renderSignals();
        this.renderLeaderboard();
        this.renderLedger();
        this.renderHealth();

        void this.refreshSignals();
        void this.refreshAlpha();
        void this.refreshPaper();
        window.setInterval(() => { void this.refreshSignals(); }, SIGNAL_POLL_MS);
        window.setInterval(() => { void this.refreshAlpha(); }, ALPHA_POLL_MS);
        window.setInterval(() => { void this.refreshPaper(); }, PAPER_POLL_MS);
        window.setInterval(() => { this.renderHealth(); }, HEALTH_TICK_MS);
    }

    private async refreshSignals(): Promise<void> {
        try {
            const raw = await fetchJsonFile("/active_signals.json");
            this.latestSignals = raw ? parseSignals(raw) : null;
            this.updateFreshSignals();
        } catch (error) {
            debugLogger.warn("ops.signals.poll_failed", { error: String(error) });
            this.latestSignals = null;
        }
        this.renderSignals();
        this.renderHealth();
    }

    private async refreshAlpha(): Promise<void> {
        try {
            const raw = await fetchJsonFile("/alpha_report.json");
            this.latestAlpha = raw ? parseAlpha(raw) : null;
        } catch (error) {
            debugLogger.warn("ops.alpha.poll_failed", { error: String(error) });
            this.latestAlpha = null;
        }
        this.renderLeaderboard();
        this.renderHealth();
    }

    private async refreshPaper(): Promise<void> {
        try {
            const raw = await fetchJsonFile("/paper_portfolio.json");
            this.latestPaper = raw ? parsePaper(raw) : null;
        } catch (error) {
            debugLogger.warn("ops.paper.poll_failed", { error: String(error) });
            this.latestPaper = null;
        }
        this.renderLedger();
        this.renderHealth();
    }

    private updateFreshSignals(): void {
        const now = Date.now();
        for (const signal of this.latestSignals?.signals ?? []) {
            if (!this.seenSignalIds.has(signal.id)) {
                this.seenSignalIds.add(signal.id);
                this.freshSignalExpiryById.set(signal.id, now + 20_000);
            }
        }
        for (const [id, expiry] of this.freshSignalExpiryById.entries()) {
            if (expiry <= now) this.freshSignalExpiryById.delete(id);
        }
    }

    private renderSignals(): void {
        if (!this.signalTickerEl || !this.signalMetaEl) return;
        const feed = this.latestSignals;
        if (!feed) {
            this.signalMetaEl.textContent = "Waiting for active_signals.json";
            this.signalTickerEl.innerHTML = `<div class="ops-empty-state">Signal Tower not emitting yet.</div>`;
            return;
        }
        this.signalMetaEl.textContent = `Updated ${relative(feed.cycleAtIso)} | Active ${feed.signals.length} | Watchlist ${feed.watchlistCount}`;
        if (feed.signals.length === 0) {
            this.signalTickerEl.innerHTML = `<div class="ops-empty-state">No active BUY/SELL signals in the latest cycle.</div>`;
            return;
        }
        const now = Date.now();
        const cards = feed.signals.slice().sort((a, b) => (b.barTime ?? 0) - (a.barTime ?? 0)).map((signal) => {
            const fresh = (this.freshSignalExpiryById.get(signal.id) ?? 0) > now ? " is-new" : "";
            const cls = signal.side === "buy" ? "buy" : signal.side === "sell" ? "sell" : "neutral";
            const reason = signal.reason ? `<div class="ops-signal-reason">${escapeHtml(signal.reason)}</div>` : "";
            return `<article class="ops-signal-card ${cls}${fresh}">
                <header class="ops-signal-card-header">
                    <span class="ops-signal-symbol">${escapeHtml(signal.symbol)}</span>
                    <span class="ops-signal-side">${escapeHtml(signal.side.toUpperCase())}</span>
                </header>
                <div class="ops-signal-price">@ ${escapeHtml(signal.price === null ? "n/a" : compact(signal.price, 8))}</div>
                <div class="ops-signal-detail">${escapeHtml([signal.strategyKey, signal.interval, signal.action.toUpperCase(), signal.detectedAtIso ? relative(signal.detectedAtIso) : "time n/a"].join(" | "))}</div>
                ${reason}
            </article>`;
        });
        this.signalTickerEl.innerHTML = cards.length > 1
            ? `<div class="ops-signal-track ops-signal-track-animated">${cards.join("")}${cards.join("")}</div>`
            : `<div class="ops-signal-track">${cards[0]}</div>`;
    }

    private renderLeaderboard(): void {
        if (!this.leaderboardBodyEl || !this.leaderboardMetaEl) return;
        const alpha = this.latestAlpha;
        if (!alpha) {
            this.leaderboardMetaEl.textContent = "Waiting for alpha_report.json";
            this.leaderboardBodyEl.innerHTML = `<tr><td colspan="7" class="ops-table-empty">No leaderboard data yet.</td></tr>`;
            return;
        }
        this.leaderboardMetaEl.textContent = `Updated ${relative(alpha.generatedAtIso)} | Ranked ${alpha.rankedCount} alphas`;
        if (alpha.rows.length === 0) {
            this.leaderboardBodyEl.innerHTML = `<tr><td colspan="7" class="ops-table-empty">No viable alpha winners found.</td></tr>`;
            return;
        }
        this.leaderboardBodyEl.innerHTML = alpha.rows.slice(0, 10).map((row, idx) => {
            const winRate = row.winRatePercent === null ? "n/a" : `${row.winRatePercent.toFixed(1)}%`;
            const profitFactor = row.profitFactor === null ? "n/a" : row.profitFactor.toFixed(2);
            const title = `Net ${row.netProfitPercent.toFixed(2)}% | Sharpe ${row.sharpeRatio.toFixed(2)} | DD ${row.maxDrawdownPercent.toFixed(2)}% | Drift ${row.drift.toFixed(4)}`;
            return `<tr>
                <td class="ops-rank">${idx + 1}</td>
                <td><div class="ops-asset-cell"><span class="ops-asset-symbol">${escapeHtml(row.symbol)}</span><span class="ops-asset-volume">${compact(row.quoteVolume, 1)} vol</span></div></td>
                <td>${escapeHtml(row.strategyKey)}</td>
                <td title="${escapeHtml(title)}">${row.robustScore.toFixed(2)}</td>
                <td>${escapeHtml(winRate)}</td>
                <td>${escapeHtml(profitFactor)}</td>
                <td><code class="ops-param-code">${escapeHtml(paramsPreview(row.params))}</code></td>
            </tr>`;
        }).join("");
    }

    private renderLedger(): void {
        if (!this.ledgerMetaEl || !this.todayPnlEl || !this.todayPnlSubtextEl || !this.totalEquityEl || !this.totalEquitySubtextEl || !this.activePositionsEl || !this.activeFloatingEl || !this.positionsBodyEl) return;
        const paper = this.latestPaper;
        if (!paper) {
            this.ledgerMetaEl.textContent = "Waiting for paper_portfolio.json";
            this.todayPnlEl.textContent = "$0.00";
            this.todayPnlSubtextEl.textContent = "Session delta";
            this.totalEquityEl.textContent = "$10,000.00";
            this.totalEquitySubtextEl.textContent = "Account growth";
            this.activePositionsEl.textContent = "0";
            this.activeFloatingEl.textContent = "Floating PnL: $0.00";
            clearSign(this.todayPnlEl);
            clearSign(this.todayPnlSubtextEl);
            clearSign(this.activeFloatingEl);
            this.positionsBodyEl.innerHTML = `<tr><td colspan="6" class="ops-table-empty">No open paper positions.</td></tr>`;
            return;
        }

        this.ledgerMetaEl.textContent = `Updated ${relative(paper.cycleAtIso)} | Trades ${paper.totalTrades} | WinRate ${paper.winRatePercent.toFixed(1)}%`;
        this.todayPnlEl.textContent = signedCurrency(paper.todayPnlUsd);
        this.todayPnlSubtextEl.textContent = `Realized ${signedCurrency(paper.realizedPnlUsd)}`;
        this.totalEquityEl.textContent = currency(paper.totalEquityUsd);
        this.totalEquitySubtextEl.textContent = `Return ${signedPercent(paper.totalReturnPercent)}`;
        this.activePositionsEl.textContent = String(paper.positions.length);
        this.activeFloatingEl.textContent = `Floating PnL: ${signedCurrency(paper.floatingPnlUsd)}`;
        applySign(this.todayPnlEl, paper.todayPnlUsd);
        applySign(this.todayPnlSubtextEl, paper.realizedPnlUsd);
        applySign(this.activeFloatingEl, paper.floatingPnlUsd);

        this.positionsBodyEl.innerHTML = paper.positions.length === 0
            ? `<tr><td colspan="6" class="ops-table-empty">No open paper positions.</td></tr>`
            : paper.positions.slice().sort((a, b) => b.floatingPnlUsd - a.floatingPnlUsd).map((position) => {
                const pnlClass = signClass(position.floatingPnlUsd);
                const ageText = position.entryTimeIso ? age(position.entryTimeIso) : "n/a";
                return `<tr>
                    <td><span class="ops-position-symbol">${escapeHtml(position.symbol)}</span></td>
                    <td>${escapeHtml(position.strategyKey)}</td>
                    <td>${escapeHtml(compact(position.entryPrice, 8))}</td>
                    <td>${escapeHtml(compact(position.markPrice, 8))}</td>
                    <td class="ops-position-pnl ${pnlClass}">${escapeHtml(signedCurrency(position.floatingPnlUsd))}</td>
                    <td>${escapeHtml(ageText)}</td>
                </tr>`;
            }).join("");
    }

    private renderHealth(): void {
        const loader = this.loaderHealth();
        const tower = this.towerHealth();
        const paper = this.paperHealth();
        this.paintCard(this.loaderCardEl, this.loaderStateEl, this.loaderValueEl, this.loaderDetailEl, loader);
        this.paintCard(this.towerCardEl, this.towerStateEl, this.towerValueEl, this.towerDetailEl, tower);
        this.paintCard(this.paperCardEl, this.paperStateEl, this.paperValueEl, this.paperDetailEl, paper);

        const overall = maxState([loader.state, tower.state, paper.state]);
        this.overallHealthEl?.classList.remove("is-ok", "is-warn", "is-stale", "is-unknown");
        this.overallHealthDotEl?.classList.remove("is-ok", "is-warn", "is-stale", "is-unknown");
        this.overallHealthEl?.classList.add(`is-${overall}`);
        this.overallHealthDotEl?.classList.add(`is-${overall}`);
        if (this.overallHealthTextEl) this.overallHealthTextEl.textContent = label(overall);
        if (this.healthMetaEl) {
            const parts: string[] = [];
            if (this.latestAlpha) parts.push(`Loader ${relative(this.latestAlpha.generatedAtIso)}`);
            if (this.latestSignals) parts.push(`Tower ${relative(this.latestSignals.cycleAtIso)}`);
            if (this.latestPaper) parts.push(`Ledger ${relative(this.latestPaper.cycleAtIso)}`);
            this.healthMetaEl.textContent = parts.length ? parts.join(" | ") : "Monitoring factory heartbeat.";
        }
    }

    private loaderHealth(): { state: HealthState; value: string; detail: string } {
        if (!this.latestAlpha?.generatedAtIso) return { state: "unknown", value: "n/a", detail: "Awaiting alpha_report.json." };
        const ageMs = elapsed(this.latestAlpha.generatedAtIso);
        const state: HealthState = ageMs > LOADER_STALE_MS ? "stale" : ageMs > LOADER_WARN_MS ? "warn" : "ok";
        return { state, value: relative(this.latestAlpha.generatedAtIso), detail: `Last fetch ${datetime(this.latestAlpha.generatedAtIso)} | Fetched now ${this.latestAlpha.fetchedNow} | Cached ${this.latestAlpha.reusedCached}` };
    }

    private towerHealth(): { state: HealthState; value: string; detail: string } {
        if (!this.latestSignals?.cycleAtIso) return { state: "unknown", value: "n/a", detail: "Awaiting active_signals.json." };
        const pollMs = Math.max(5_000, this.latestSignals.pollSeconds * 1000);
        const ageMs = elapsed(this.latestSignals.cycleAtIso);
        const state: HealthState = ageMs > pollMs * 4 ? "stale" : ageMs > pollMs * 2 ? "warn" : "ok";
        return { state, value: relative(this.latestSignals.cycleAtIso), detail: `Last scan ${datetime(this.latestSignals.cycleAtIso)} | Poll ${this.latestSignals.pollSeconds}s | Active ${this.latestSignals.signals.length}` };
    }

    private paperHealth(): { state: HealthState; value: string; detail: string } {
        if (!this.latestPaper?.cycleAtIso) return { state: "unknown", value: "n/a", detail: "Awaiting paper_portfolio.json." };
        const pollMs = Math.max(2_000, this.latestPaper.pollSeconds * 1000);
        const ageMs = elapsed(this.latestPaper.cycleAtIso);
        const staleFromSignal = this.latestPaper.sourceStatus === "error";
        const state: HealthState = staleFromSignal ? "warn" : ageMs > pollMs * 4 ? "stale" : ageMs > pollMs * 2 ? "warn" : "ok";
        return { state, value: relative(this.latestPaper.cycleAtIso), detail: `Signals ${this.latestPaper.sourceStatus} | Trades ${this.latestPaper.totalTrades} | Open ${this.latestPaper.positions.length}` };
    }

    private paintCard(card: HTMLElement | null, stateEl: HTMLElement | null, valueEl: HTMLElement | null, detailEl: HTMLElement | null, payload: { state: HealthState; value: string; detail: string }): void {
        card?.classList.remove("is-ok", "is-warn", "is-stale", "is-unknown");
        card?.classList.add(`is-${payload.state}`);
        if (stateEl) stateEl.textContent = label(payload.state);
        if (valueEl) valueEl.textContent = payload.value;
        if (detailEl) detailEl.textContent = payload.detail;
    }
}

async function fetchJsonFile(pathname: string): Promise<JsonRecord | null> {
    const response = await fetch(`${pathname}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return isRecord(payload) ? payload : null;
}

function parseSignals(raw: JsonRecord): ParsedSignalFeed {
    const activeSignals = Array.isArray(raw.activeSignals) ? raw.activeSignals : [];
    const signals: ParsedSignal[] = [];
    for (let i = 0; i < activeSignals.length; i++) {
        const row = asRecord(activeSignals[i]);
        if (!row) continue;
        const symbol = asText(row.symbol);
        const strategyKey = asText(row.strategyKey);
        const interval = asText(row.interval);
        const sideText = asText(row.side)?.toLowerCase();
        const side: ParsedSignal["side"] = sideText === "buy" || sideText === "sell" ? sideText : "unknown";
        if (!symbol || !strategyKey || !interval) continue;
        signals.push({
            id: asText(row.id) ?? `${symbol}|${strategyKey}|${i}`,
            symbol,
            strategyKey,
            interval,
            side,
            action: asText(row.action) ?? "signal",
            price: asNum(row.price),
            barTime: asNum(row.barTime),
            detectedAtIso: asIso(row.detectedAt ?? row.barTimeIso),
            reason: asText(row.reason) ?? "",
        });
    }
    return {
        generatedAtIso: asIso(raw.generatedAt),
        cycleAtIso: asIso(raw.cycleAt),
        pollSeconds: Math.max(5, Math.floor(asNum(raw.pollSeconds) ?? 60)),
        watchlistCount: Array.isArray(raw.watchlist) ? raw.watchlist.length : 0,
        signals,
    };
}

function parseAlpha(raw: JsonRecord): ParsedAlpha {
    const winners = Array.isArray(raw.winners) ? raw.winners : [];
    const symbolMap = new Map<string, JsonRecord>();
    for (const row of Array.isArray(raw.symbols) ? raw.symbols : []) {
        const rec = asRecord(row);
        const symbol = asText(rec?.symbol)?.toUpperCase();
        if (rec && symbol) symbolMap.set(symbol, rec);
    }
    const rows: LeaderboardRow[] = [];
    for (const winnerRow of winners) {
        const winner = asRecord(winnerRow);
        const symbol = asText(winner?.symbol)?.toUpperCase();
        const strategyKey = asText(winner?.strategyKey);
        const params = numericRecord(winner?.alphaGenome);
        if (!winner || !symbol || !strategyKey || Object.keys(params).length === 0) continue;
        const symbolEntry = symbolMap.get(symbol);
        const quoteVolume = asNum(symbolEntry?.quoteVolume) ?? 0;
        const netProfitPercent = asNum(winner.netProfitPercent) ?? 0;
        const sharpeRatio = asNum(winner.sharpeRatio) ?? 0;
        const maxDrawdownPercent = asNum(winner.maxDrawdownPercent) ?? 999;
        const totalTrades = Math.max(0, Math.floor(asNum(winner.totalTrades) ?? 0));
        const drift = Math.abs(asNum(winner.drift) ?? (1 / Math.sqrt(Math.max(1, totalTrades))));
        const robustScore = netProfitPercent * 0.7 + sharpeRatio * 25 - maxDrawdownPercent * 0.8 - drift * 20;
        const winRate = normalizeWinRate(asNum(winner.winRatePercent) ?? asNum(winner.winRate));
        const profitFactor = asNum(winner.profitFactor);
        rows.push({ symbol, strategyKey, robustScore, netProfitPercent, sharpeRatio, maxDrawdownPercent, drift, quoteVolume, winRatePercent: winRate, profitFactor, params });
    }
    const source = rows.filter((row) => row.quoteVolume >= 25_000_000 && row.maxDrawdownPercent <= 45 && row.sharpeRatio > 0);
    const chosen = source.length >= 10 ? source : rows;
    chosen.sort((a, b) => b.robustScore - a.robustScore);
    const market = asRecord(raw.market);
    return {
        generatedAtIso: asIso(raw.generatedAt),
        fetchedNow: Math.max(0, Math.floor(asNum(market?.fetchedNow) ?? 0)),
        reusedCached: Math.max(0, Math.floor(asNum(market?.reusedCached) ?? 0)),
        rankedCount: rows.length,
        rows: chosen,
    };
}

function parsePaper(raw: JsonRecord): ParsedPaper {
    const account = asRecord(raw.account);
    const stats = asRecord(raw.stats);
    const signalState = asRecord(raw.signalState);
    const positions = (Array.isArray(raw.openPositions) ? raw.openPositions : []).map((row) => {
        const rec = asRecord(row);
        const symbol = asText(rec?.symbol);
        const strategyKey = asText(rec?.strategyKey);
        if (!rec || !symbol || !strategyKey) return null;
        return {
            symbol,
            strategyKey,
            entryPrice: asNum(rec.entryPrice) ?? 0,
            markPrice: asNum(rec.markPrice) ?? asNum(rec.entryPrice) ?? 0,
            floatingPnlUsd: asNum(rec.floatingPnlUsd) ?? 0,
            entryTimeIso: asIso(rec.entryTimeIso),
        };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    return {
        generatedAtIso: asIso(raw.generatedAt),
        cycleAtIso: asIso(raw.cycleAt),
        pollSeconds: Math.max(2, Math.floor(asNum(raw.pollSeconds) ?? 5)),
        todayPnlUsd: asNum(account?.todayPnlUsd) ?? 0,
        totalEquityUsd: asNum(account?.totalEquityUsd) ?? 0,
        floatingPnlUsd: asNum(account?.floatingPnlUsd) ?? 0,
        realizedPnlUsd: asNum(account?.realizedPnlUsd) ?? 0,
        totalReturnPercent: asNum(account?.totalReturnPercent) ?? 0,
        totalTrades: Math.max(0, Math.floor(asNum(stats?.totalTrades) ?? 0)),
        winRatePercent: asNum(stats?.winRatePercent) ?? 0,
        sourceStatus: asText(signalState?.sourceStatus) ?? "unknown",
        positions,
    };
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): JsonRecord | null { return isRecord(value) ? value : null; }
function asText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function asNum(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function asIso(value: unknown): string | null { const t = asText(value); if (!t) return null; const p = Date.parse(t); return Number.isFinite(p) ? new Date(p).toISOString() : null; }
function normalizeWinRate(value: number | null): number | null { if (value === null) return null; if (value >= 0 && value <= 1) return value * 100; if (value >= 1 && value <= 100) return value; return null; }
function numericRecord(value: unknown): Record<string, number> { const rec = asRecord(value); if (!rec) return {}; const out: Record<string, number> = {}; for (const [k, v] of Object.entries(rec)) { const n = asNum(v); if (n !== null) out[k] = n; } return out; }
function elapsed(iso: string | null): number { if (!iso) return Number.POSITIVE_INFINITY; const p = Date.parse(iso); if (!Number.isFinite(p)) return Number.POSITIVE_INFINITY; return Math.max(0, Date.now() - p); }
function relative(iso: string | null): string { const ms = elapsed(iso); if (!Number.isFinite(ms)) return "n/a"; if (ms < 10_000) return "just now"; if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`; if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`; return `${Math.floor(ms / 86_400_000)}d ago`; }
function age(iso: string): string { const ms = elapsed(iso); if (!Number.isFinite(ms)) return "n/a"; if (ms < 60_000) return `${Math.floor(ms / 1000)}s`; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`; return `${Math.floor(ms / 3_600_000)}h`; }
function datetime(iso: string | null): string { if (!iso) return "n/a"; const p = Date.parse(iso); if (!Number.isFinite(p)) return "n/a"; return new Date(p).toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
function compact(value: number, digits: number): string { if (!Number.isFinite(value)) return "n/a"; const abs = Math.abs(value); if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`; if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`; if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`; if (abs >= 1) return value.toFixed(Math.min(2, digits)); return value.toFixed(digits); }
function paramsPreview(params: Record<string, number>): string { const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)); if (!entries.length) return "n/a"; const view = entries.slice(0, 4).map(([k, v]) => `${k}:${trimNumber(v)}`); if (entries.length > 4) view.push(`+${entries.length - 4}`); return view.join(" | "); }
function trimNumber(value: number): string { if (!Number.isFinite(value)) return "n/a"; if (Math.abs(value) >= 1000) return value.toFixed(0); if (Math.abs(value) >= 10) return value.toFixed(2); if (Math.abs(value) >= 1) return value.toFixed(3); return value.toFixed(4); }
function currency(value: number): string { if (!Number.isFinite(value)) return "$0.00"; return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }
function signedCurrency(value: number): string { return `${value > 0 ? "+" : ""}${currency(value)}`; }
function signedPercent(value: number): string { return `${value > 0 ? "+" : ""}${(Number.isFinite(value) ? value : 0).toFixed(2)}%`; }
function signClass(value: number): string { if (value > 0) return "is-positive"; if (value < 0) return "is-negative"; return ""; }
function applySign(el: HTMLElement, value: number): void { el.classList.remove("is-positive", "is-negative"); if (value > 0) el.classList.add("is-positive"); else if (value < 0) el.classList.add("is-negative"); }
function clearSign(el: HTMLElement): void { el.classList.remove("is-positive", "is-negative"); }
function maxState(states: HealthState[]): HealthState { const rank: Record<HealthState, number> = { stale: 4, warn: 3, unknown: 2, ok: 1 }; return states.reduce((acc, cur) => (rank[cur] > rank[acc] ? cur : acc), "ok"); }
function label(state: HealthState): string { if (state === "ok") return "Stable"; if (state === "warn") return "Lagging"; if (state === "stale") return "Stale"; return "Unknown"; }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

export const liveOperationsDashboard = new LiveOperationsDashboard();
