import type { Time } from "lightweight-charts";
import type { OHLCVData, Trade } from "../strategies/index";
import { setVisible } from "../dom-utils";
import { state } from "../state";
import { debugLogger } from "../debug-logger";
import { escapeHtml } from "../html-escape";
import { resolveOpenTradeDisplayMetrics } from "../open-trade-display";
import { createTradesRendererDom, type TradesRendererDom } from "./trades-renderer-dom";
import {
    getEffectivePolymarketSeriesId,
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
} from "../polymarket-btc5m";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "../polymarket-exit-mode";
import {
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesForTrades,
} from "../polymarket-signal-exit-evaluator";
import { ensurePricePointsForOutcomes } from "../polymarket-price-points-ingest";
import { resolveBacktestResultMarketContext } from "../backtest-result-context";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
import { resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import { resolveCurrentAlertSubscriptionContext } from "../current-alert-subscription";
import { livePositionsService, type LivePosition } from "../live-positions-service";
import {
    hasFilteredPolymarketTrades,
    isActualPolymarketEntryMinuteMode,
    resolvePolymarketEntrySelectionModeForDisplay,
    type PolymarketEntrySelectionMode,
} from "../polymarket-entry-selection-mode";

export class TradesRenderer {
    private static readonly MAX_TRADES = 250;
    private static readonly INITIAL_RENDER_BATCH_SIZE = 20;
    private static readonly DEFERRED_RENDER_BATCH_SIZE = 30;
    private static readonly LIVE_POSITION_STALE_AFTER_MS = 90_000;

    private dom: TradesRendererDom | null = null;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private jumpHandlersBound = false;
    private tradeRenderGeneration = 0;
    private pendingDeferredRenderIds: number[] = [];
    private lastPolymarketAnnotationKey = '';
    private lastPolymarketAnnotationPromise: Promise<Trade[]> | null = null;

    private getDom(): TradesRendererDom {
        return this.dom ??= createTradesRendererDom();
    }

    public async render(
        trades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): Promise<boolean> {
        const container = this.getDom().tradesList;
        this.jumpToTrade = jumpToTrade;
        this.ensureTradeJumpHandlersBound();
        this.cancelPendingDeferredRenders();
        const renderGeneration = ++this.tradeRenderGeneration;
        container.classList.remove('trades-list-parity');

        // Load Polymarket outcomes on-demand for Trades panel display
        const annotatedTrades = await this.ensurePolymarketOutcomes(trades);
        if (renderGeneration !== this.tradeRenderGeneration) {
            return false;
        }

        if (annotatedTrades.length === 0) {
            setVisible('emptyTrades', true);
            setVisible('tradesSummary', false);
            container.innerHTML = '';
            return true;
        }

        setVisible('emptyTrades', false);
        setVisible('tradesSummary', true);
        this.updateSummary(annotatedTrades);

        this.renderTradeItemsProgressively(renderGeneration, container, annotatedTrades, formatPrice, formatDate);
        return true;
    }

    private async ensurePolymarketOutcomes(trades: Trade[]): Promise<Trade[]> {
        const entrySelectionMode = this.resolveSelectedPolymarketEntrySelectionMode();
        const shouldRepairFilteredActualMode = isActualPolymarketEntryMinuteMode(entrySelectionMode)
            && hasFilteredPolymarketTrades(trades);

        // Check if already annotated
        const hasOutcomes = trades.some((trade) => trade.polymarketOutcome !== undefined && trade.polymarketOutcome !== null);
        if (hasOutcomes && !shouldRepairFilteredActualMode) {
            return trades;
        }

        if (!this.isTradesPanelVisible()) {
            return trades;
        }

        const cacheKey = this.getPolymarketAnnotationCacheKey(trades);
        if (cacheKey && this.lastPolymarketAnnotationKey === cacheKey && this.lastPolymarketAnnotationPromise) {
            return await this.lastPolymarketAnnotationPromise;
        }

        const annotationPromise = this.loadPolymarketOutcomesForTrades(trades);
        this.lastPolymarketAnnotationKey = cacheKey;
        this.lastPolymarketAnnotationPromise = annotationPromise;
        return await annotationPromise;
    }

    private isTradesPanelVisible(): boolean {
        const panel = document.getElementById('tradesTab') as HTMLElement | null;
        return Boolean(panel && !panel.hidden && panel.style.display !== 'none');
    }

    private getPolymarketAnnotationCacheKey(trades: readonly Trade[]): string {
        if (trades.length === 0) {
            return '';
        }

        const resultContext = resolveBacktestResultMarketContext(state.currentBacktestResult);
        const summaryOffset = state.currentBacktestResult?.polymarketTradeSummary?.entryOffset;
        const entrySelectionMode = state.currentBacktestResult?.polymarketTradeSummary?.entrySelectionMode
            ?? this.resolveSelectedPolymarketEntrySelectionMode();
        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol();
        const evaluationMode = state.currentBacktestResult?.polymarketTradeSummary?.evaluationMode ?? "resolve_hold";
        const entryDelayBars = state.currentBacktestResult?.polymarketTradeSummary?.entryDelayBars
            ?? (typeof document === "undefined" ? 0 : resolvePolymarketDomSettings().entryDelayBars);
        const firstTrade = trades[0];
        const lastTrade = trades[trades.length - 1];
        return [
            resultContext?.symbol ?? state.currentSymbol,
            resultContext?.interval ?? state.currentInterval,
            outcomeSymbol ?? "same",
            entrySelectionMode,
            typeof summaryOffset === 'number' ? summaryOffset : (isActualPolymarketEntryMinuteMode(entrySelectionMode) ? 'auto' : 'na'),
            evaluationMode,
            entryDelayBars,
            trades.length,
            parseTimeToUnixSeconds(firstTrade.entryTime) ?? 'na',
            parseTimeToUnixSeconds(lastTrade.entryTime) ?? 'na',
        ].join('|');
    }

    private resolveSelectedPolymarketEntrySelectionMode(): PolymarketEntrySelectionMode {
        const domEntrySelectionMode = typeof document === "undefined"
            ? undefined
            : resolvePolymarketDomSettings().entrySelectionMode;
        return resolvePolymarketEntrySelectionModeForDisplay(
            state.currentBacktestResult?.polymarketTradeSummary?.entrySelectionMode,
            domEntrySelectionMode,
            state.currentBacktestResult?.trades
        );
    }

    private resolveSelectedPolymarketEntryOffset(): number | undefined {
        if (this.readCurrentPolymarketOutcomeInterval() !== "5m") {
            return undefined;
        }
        const summaryOffset = state.currentBacktestResult?.polymarketTradeSummary?.entryOffset;
        if (typeof summaryOffset === 'number' && Number.isFinite(summaryOffset)) {
            return Math.max(0, Math.min(4, Math.floor(summaryOffset)));
        }

        if (isActualPolymarketEntryMinuteMode(this.resolveSelectedPolymarketEntrySelectionMode())) {
            return undefined;
        }

        const entryOffset = typeof document === "undefined"
            ? null
            : resolvePolymarketDomSettings().entryOffset;
        if (entryOffset !== null) {
            return Math.max(0, Math.min(4, Math.floor(entryOffset)));
        }

        return 0;
    }

    private readCurrentPolymarketOutcomeSymbol(): string | null {
        return typeof document === "undefined"
            ? null
            : resolvePolymarketDomSettings().outcomeSymbol;
    }

    private readCurrentPolymarketOutcomeInterval(): PolymarketOutcomeInterval {
        return typeof document === "undefined"
            ? "5m"
            : resolvePolymarketDomSettings().outcomeInterval;
    }

    private readCurrentPolymarketExitMode(): "resolve_hold" | "signal_exit_same_event" | undefined {
        return typeof document === "undefined"
            ? undefined
            : resolvePolymarketDomSettings().exitMode;
    }

    private readCurrentExecutionModel(): string | undefined {
        return typeof document === "undefined"
            ? undefined
            : resolvePolymarketDomSettings().executionModel;
    }

    private resolveActivePolymarketOutcomeSymbol(): string | null {
        const summarySymbol = state.currentBacktestResult?.polymarketTradeSummary?.outcomeSymbol;
        if (typeof summarySymbol === 'string' && summarySymbol.trim().length > 0) {
            return summarySymbol.trim().toUpperCase();
        }
        return this.readCurrentPolymarketOutcomeSymbol();
    }

    private resolveActivePolymarketOutcomeInterval(): PolymarketOutcomeInterval {
        return resolvePolymarketOutcomeInterval(
            state.currentBacktestResult?.polymarketTradeSummary?.outcomeInterval ?? this.readCurrentPolymarketOutcomeInterval()
        );
    }

    private async loadPolymarketOutcomesForTrades(trades: Trade[]): Promise<Trade[]> {
        if (trades.length === 0) {
            return trades;
        }

        const resultContext = resolveBacktestResultMarketContext(state.currentBacktestResult);
        if (!resultContext) {
            return trades;
        }

        const outcomeSymbol = this.resolveActivePolymarketOutcomeSymbol();
        const outcomeInterval = this.resolveActivePolymarketOutcomeInterval();
        if (!isSupportedPolymarketOutcomeRun(resultContext.symbol, resultContext.interval, outcomeInterval, outcomeSymbol)) {
            return trades;
        }

        const seriesId = getEffectivePolymarketSeriesId(resultContext.symbol, outcomeInterval, outcomeSymbol);
        if (!seriesId) {
            return trades;
        }

        // Collect entry times from trades
        const targetTimes = trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);
        if (targetTimes.length === 0) {
            return trades;
        }

        const startTs = Math.min(...targetTimes);
        const endTs = Math.max(...targetTimes);

        // Load outcomes from SQLite (uses in-memory cache)
        const outcomes = await loadPolymarketOutcomesForTimeRange(resultContext.symbol, startTs, endTs, outcomeSymbol, outcomeInterval);
        if (outcomes.length === 0) {
            return trades;
        }

        const effectiveExitMode = state.currentBacktestResult?.polymarketTradeSummary?.evaluationMode
            ?? resolveEffectivePolymarketExitMode({
                requestedMode: this.readCurrentPolymarketExitMode(),
                interval: resultContext.interval,
                executionModel: this.readCurrentExecutionModel(),
                polymarketAnnotationEnabled: true,
        });
        const currentPolymarketSettings = resolvePolymarketDomSettings();
        const allowMultipleTradesPerEvent = state.currentBacktestResult?.polymarketTradeSummary?.evaluationMode === "signal_exit_same_event"
            ? state.currentBacktestResult.polymarketTradeSummary.signalExitAllowMultipleTradesPerEvent === true
            : currentPolymarketSettings.signalExitAllowMultipleTradesPerEvent;
        const existingLimitSummary = state.currentBacktestResult?.polymarketTradeSummary?.limitEntryEnabled === true
            ? state.currentBacktestResult.polymarketTradeSummary
            : null;
        const limitEntry = outcomeInterval === "5m"
            && (
                existingLimitSummary
                || (!state.currentBacktestResult?.polymarketTradeSummary && currentPolymarketSettings.postSignalLimitEntryEnabled)
            )
            ? {
                enabled: true,
                priceMode: existingLimitSummary?.limitEntryMode
                    ?? currentPolymarketSettings.postSignalLimitEntryMode,
                priceCents: existingLimitSummary?.limitEntryPriceCents
                    ?? currentPolymarketSettings.postSignalLimitEntryPriceCents,
                offsetCents: existingLimitSummary?.limitEntryOffsetCents
                    ?? currentPolymarketSettings.postSignalLimitEntryOffsetCents,
                exitEnabled: existingLimitSummary
                    ? existingLimitSummary.limitExitEnabled === true
                    : currentPolymarketSettings.postSignalLimitExitEnabled,
                exitMode: existingLimitSummary?.limitExitMode
                    ?? currentPolymarketSettings.postSignalLimitExitMode,
                exitPriceCents: existingLimitSummary?.limitExitPriceCents
                    ?? currentPolymarketSettings.postSignalLimitExitPriceCents,
                exitOffsetCents: existingLimitSummary?.limitExitOffsetCents
                    ?? currentPolymarketSettings.postSignalLimitExitOffsetCents,
            }
            : undefined;

        if (isSignalExitSameEventMode(effectiveExitMode) && resultContext.interval === "1m") {
            try {
                const outcomeByEntryTs = indexSignalExitOutcomesForTrades(trades, outcomes);
                const relevantOutcomeByStart = new Map<number, (typeof outcomes)[number]>();
                for (const outcome of outcomeByEntryTs.values()) {
                    if (outcome) {
                        relevantOutcomeByStart.set(outcome.event_start_ts, outcome);
                    }
                }
                const pricePoints = await ensurePricePointsForOutcomes(
                    relevantOutcomeByStart.size > 0 ? [...relevantOutcomeByStart.values()] : outcomes,
                    seriesId
                );
                const { results: exitResults } = evaluateSignalExitTrades({
                    trades,
                    outcomes,
                    pricePoints,
                    outcomeByEntryTs,
                    allowMultipleTradesPerEvent,
                    entryPriceFilterCents: currentPolymarketSettings.entryPriceFilterCents,
                    backtestSlippageCents: currentPolymarketSettings.backtestSlippageCents,
                    entryCutoffEnabled: currentPolymarketSettings.entryCutoffEnabled,
                    entryCutoffSeconds: currentPolymarketSettings.entryCutoffSeconds,
                    limitEntry,
                });
                const exitResultMap = new Map(exitResults.map((r) => [r.trade, r]));
                return trades.map((trade) => {
                    const exitResult = exitResultMap.get(trade);
                    if (!exitResult) return { ...trade, polymarketOutcome: null };
                    const annotation = buildTradeAnnotationFromSignalExitResult(exitResult);
                    return { ...trade, polymarketOutcome: annotation };
                });
            } catch (error) {
                debugLogger.warn("trades.polymarket_signal_exit_annotation_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const entrySelectionMode = resultContext.interval === '1m'
            && outcomeInterval === "5m"
            ? this.resolveSelectedPolymarketEntrySelectionMode()
            : "fixed_offset";
        const selectedOffset = resultContext.interval === '1m'
            && outcomeInterval === "5m"
            ? this.resolveSelectedPolymarketEntryOffset()
            : undefined;
        let limitEntryPricePoints: Awaited<ReturnType<typeof ensurePricePointsForOutcomes>> | undefined;
        if (limitEntry) {
            try {
                limitEntryPricePoints = await ensurePricePointsForOutcomes(outcomes, seriesId);
            } catch {
                limitEntryPricePoints = [];
            }
        }
        const { annotateTradesWithPolymarketOutcomesForRun } = await import("../polymarket-trade-annotations");
        return annotateTradesWithPolymarketOutcomesForRun(
            trades,
            outcomes,
            resultContext.interval,
            selectedOffset,
            entrySelectionMode,
            {
                outcomeInterval,
                pricePoints: limitEntryPricePoints,
                entryPriceFilterCents: currentPolymarketSettings.entryPriceFilterCents,
                backtestSlippageCents: currentPolymarketSettings.backtestSlippageCents,
                entryCutoffEnabled: currentPolymarketSettings.entryCutoffEnabled,
                entryCutoffSeconds: currentPolymarketSettings.entryCutoffSeconds,
                limitEntry,
            }
        );
    }

    private formatDuration(ms: number): string {
        if (ms < 0) return '-';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    private getExitReasonBadge(exitReason: Trade['exitReason']): string {
        if (!exitReason) return '';

        const reasonMap: Record<NonNullable<Trade['exitReason']>, { label: string; className: string; icon: string }> = {
            signal: { label: 'Signal', className: 'exit-reason-badge--signal', icon: 'SIG' },
            stop_loss: { label: 'SL', className: 'exit-reason-badge--stop-loss', icon: 'SL' },
            take_profit: { label: 'TP', className: 'exit-reason-badge--take-profit', icon: 'TP' },
            trailing_stop: { label: 'Trail', className: 'exit-reason-badge--trailing-stop', icon: 'TRL' },
            time_stop: { label: 'Time', className: 'exit-reason-badge--time-stop', icon: 'T' },
            partial: { label: 'Partial', className: 'exit-reason-badge--partial', icon: '1/2' },
            probation_fail: { label: 'Guard', className: 'exit-reason-badge--probation-fail', icon: 'GRD' },
            end_of_data: { label: 'EOD', className: 'exit-reason-badge--end-of-data', icon: 'EOD' },
        };

        const info = reasonMap[exitReason];
        if (!info) return '';

        return `<span class="exit-reason-badge ${info.className}" title="Exit: ${info.label}">${info.icon}</span>`;
    }

    private getPolymarketOutcomeBadge(trade: Trade): string {
        const liveOpenBadge = this.getWorkerBackedPolymarketOpenBadge(trade);
        if (liveOpenBadge) {
            return liveOpenBadge;
        }

        const outcome = trade.polymarketOutcome;
        if (!outcome) {
            return '';
        }

        if (outcome.marketExitSource === "duplicate") {
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly Dup: another trade in the same Polymarket session was already scored">Poly dup</span>`;
        }
        if (outcome.marketExitSource === "filtered") {
            const entryOffset = typeof outcome.entryOffset === "number" && Number.isFinite(outcome.entryOffset)
                ? Math.max(0, Math.floor(outcome.entryOffset))
                : null;
            const entryMinute = entryOffset === null ? "a different minute" : `minute ${entryOffset}`;
            const activeOffset = typeof document === "undefined"
                ? state.currentBacktestResult?.polymarketTradeSummary?.entryOffset
                : this.resolveSelectedPolymarketEntryOffset();
            const activeMinute = typeof activeOffset === "number" && Number.isFinite(activeOffset)
                ? `minute ${activeOffset}`
                : "the active 1m bridge selection";
            const badgeLabel = entryOffset === null ? "Poly skip" : `Poly skip m${entryOffset}`;
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly Skip: resolve-hold scoring excluded this trade because it entered on ${escapeHtml(entryMinute)} instead of ${escapeHtml(activeMinute)}">${escapeHtml(badgeLabel)}</span>`;
        }
        if (outcome.marketExitSource === "entry_price_filtered") {
            const entryPrice = typeof outcome.marketEntryPrice === "number" && Number.isFinite(outcome.marketEntryPrice)
                ? this.formatPolymarketEntryPrice(outcome.marketEntryPrice)
                : "n/a";
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly Price Filter: entry price ${escapeHtml(entryPrice)} is outside the configured scoring band">Poly price</span>`;
        }
        if (outcome.marketExitSource === "entry_time_filtered") {
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly Time Filter: entry is inside the configured event-close cutoff">Poly time</span>`;
        }
        if (outcome.marketExitSource === "no_event") {
            if (this.isCurrentSignalExitPolymarketTradeInCurrentBucket(trade)) {
                return '';
            }
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly No Event: no matching Polymarket session was found for this trade's entry time">Poly no event</span>`;
        }
        if (outcome.marketEntrySource === "limit" && outcome.marketEntryStatus && outcome.marketEntryStatus !== "filled") {
            const labels: Record<string, { label: string; title: string }> = {
                not_touched: {
                    label: "Poly limit miss",
                    title: "Poly limit miss: the selected side never touched the configured limit before the cutoff.",
                },
                last_minute_only: {
                    label: "Poly last-min",
                    title: "Poly last-min: the selected side touched the limit only inside the rejected final minute.",
                },
                missing_price_points: {
                    label: "Poly no price",
                    title: "Poly no price: no local price point was available for the selected side after chart entry.",
                },
                invalid_window: {
                    label: "Poly limit miss",
                    title: "Poly limit miss: the chart entry or limit fill was outside the allowed event window.",
                },
            };
            const badge = labels[outcome.marketEntryStatus] ?? labels.not_touched;
            return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span>`;
        }

        const isSignalExit = outcome.evaluationMode === "signal_exit_same_event";

        if (isSignalExit) {
            if (outcome.marketExitSource === "missing") {
                return `<span class="exit-reason-badge exit-reason-badge--polymarket-skip" title="Poly n/a: missing price point data for entry or exit">Poly n/a</span>`;
            }

            const pnl = typeof outcome.marketPnl === 'number' && Number.isFinite(outcome.marketPnl)
                ? outcome.marketPnl
                : null;
            const exitBadgeLabel = outcome.marketExitSource === 'target'
                ? 'Poly target'
                : outcome.marketExitSource === 'signal'
                ? (outcome.marketEntrySource === "limit" ? 'Poly limit fill' : 'Poly Exit')
                : (outcome.marketEntrySource === "limit" ? 'Poly limit fill' : 'Poly Settle');
            const className = pnl === null
                ? ''
                : pnl > 0
                    ? 'exit-reason-badge--polymarket-win'
                    : pnl < 0
                        ? 'exit-reason-badge--polymarket-lose'
                        : '';
            const prediction = outcome.prediction.toUpperCase();
            const entryPrice = typeof outcome.marketEntryPrice === 'number' && Number.isFinite(outcome.marketEntryPrice)
                ? this.formatPolymarketEntryPrice(outcome.marketEntryPrice)
                : 'n/a';
            const exitPrice = typeof outcome.marketExitPrice === 'number' && Number.isFinite(outcome.marketExitPrice)
                ? this.formatPolymarketEntryPrice(outcome.marketExitPrice)
                : outcome.marketExitSource ?? 'n/a';
            const exitTimeLabel = this.formatPolymarketExitTime(outcome.marketExitTs);
            const chartExitLabel = trade.exitReason ? trade.exitReason.replace(/_/g, ' ') : 'unknown';
            const pnlLabel = pnl !== null
                ? `${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(1)}c`
                : '';
            const priceLabelForDisplay = `${prediction} ${entryPrice}->${exitPrice}${pnlLabel ? ` (${pnlLabel})` : ''}`;
            const marketSlug = escapeHtml(outcome.marketSlug);
            const marketUrl = escapeHtml(this.buildPolymarketMarketUrl(outcome.marketSlug));
            const title = outcome.marketExitSource === 'target'
                ? `Signal-exit mode. ${exitBadgeLabel}. Predicted ${prediction}, entry ${entryPrice}, target exited at ${exitPrice} (${exitTimeLabel}). Chart exit: ${chartExitLabel}. Click to copy ${marketSlug}.`
                : outcome.marketExitSource === 'signal'
                    ? `Signal-exit mode. ${exitBadgeLabel}. Predicted ${prediction}, entry ${entryPrice}, exited same-event at ${exitPrice} (${exitTimeLabel}). Chart exit: ${chartExitLabel}. Click to copy ${marketSlug}.`
                    : `Signal-exit mode. ${exitBadgeLabel}. Predicted ${prediction}, entry ${entryPrice}, settled at event end at ${exitPrice} (${exitTimeLabel}) after chart exit: ${chartExitLabel}. Click to copy ${marketSlug}.`;
            return `<span class="exit-reason-badge trade-polymarket-link ${className}" role="button" tabindex="0" data-polymarket-url="${marketUrl}" title="${escapeHtml(title)}">${exitBadgeLabel} ${priceLabelForDisplay}</span>`;
        }

        const isTargetExit = outcome.marketExitSource === "target";
        const label = isTargetExit ? "Poly target" : outcome.marketEntrySource === "limit" ? 'Poly limit fill' : outcome.isWin ? 'Poly Win' : 'Poly Lose';
        const realizedPnl = typeof outcome.marketPnl === "number" && Number.isFinite(outcome.marketPnl)
            ? outcome.marketPnl
            : null;
        const className = isTargetExit && realizedPnl !== null
            ? realizedPnl >= 0
                ? 'exit-reason-badge--polymarket-win'
                : 'exit-reason-badge--polymarket-lose'
            : outcome.isWin
            ? 'exit-reason-badge--polymarket-win'
            : 'exit-reason-badge--polymarket-lose';
        const actual = outcome.actualOutcomeUp === 1 ? 'UP' : 'DOWN';
        const prediction = outcome.prediction.toUpperCase();
        const yesPrice = typeof outcome.marketYesPrice === 'number' && Number.isFinite(outcome.marketYesPrice)
            ? this.formatPolymarketEntryPrice(outcome.marketYesPrice)
            : 'n/a';
        const noPrice = typeof outcome.marketNoPrice === 'number' && Number.isFinite(outcome.marketNoPrice)
            ? this.formatPolymarketEntryPrice(outcome.marketNoPrice)
            : 'n/a';
        const paidPrice = typeof outcome.marketEntryPrice === 'number' && Number.isFinite(outcome.marketEntryPrice)
            ? this.formatPolymarketEntryPrice(outcome.marketEntryPrice)
            : 'n/a';
        const resolvedExitPrice = isTargetExit && typeof outcome.marketExitPrice === "number" && Number.isFinite(outcome.marketExitPrice)
            ? this.formatPolymarketEntryPrice(outcome.marketExitPrice)
            : typeof outcome.isWin === 'boolean'
            ? this.formatPolymarketEntryPrice(outcome.isWin ? 1 : 0)
            : null;
        const payout = isTargetExit
            ? realizedPnl
            : typeof outcome.marketEntryPrice === 'number' && Number.isFinite(outcome.marketEntryPrice) && typeof outcome.isWin === 'boolean'
            ? (outcome.isWin ? (1 - outcome.marketEntryPrice) : -outcome.marketEntryPrice)
            : null;
        const payoutLabel = payout !== null
            ? `${payout >= 0 ? '+' : ''}${(payout * 100).toFixed(1)}c`
            : null;
        const priceLabel = resolvedExitPrice
            ? `${prediction} ${paidPrice}->${resolvedExitPrice}${payoutLabel ? ` (${payoutLabel})` : ''}`
            : `${prediction} ${paidPrice}`;
        const marketSlug = escapeHtml(outcome.marketSlug);
        const marketUrl = escapeHtml(this.buildPolymarketMarketUrl(outcome.marketSlug));
        const title = isTargetExit
            ? `Polymarket ${label}. Predicted ${prediction}, paid ${paidPrice}, target exited at ${resolvedExitPrice}${payoutLabel ? ` (${payoutLabel})` : ''}. YES ${yesPrice} / NO ${noPrice}. Click to copy ${marketSlug}.`
            : `Polymarket ${label}. Predicted ${prediction}, resolved ${actual}, paid ${paidPrice}${resolvedExitPrice ? `, settled at ${resolvedExitPrice}` : ''}${payoutLabel ? ` (${payoutLabel})` : ''}. YES ${yesPrice} / NO ${noPrice}. Click to copy ${marketSlug}.`;
        return `<span class="exit-reason-badge trade-polymarket-link ${className}" role="button" tabindex="0" data-polymarket-url="${marketUrl}" title="${escapeHtml(title)}">${label} ${priceLabel}</span>`;
    }

    private getWorkerBackedPolymarketOpenBadge(trade: Trade): string {
        const livePosition = this.resolveWorkerBackedOpenPolymarketPosition();
        const localOpenTrade = livePosition?.localBacktestTrade;
        if (!livePosition || !localOpenTrade || localOpenTrade.exitReason !== "end_of_data") {
            return '';
        }

        if (!this.tradesMatchForLiveOpenBadge(localOpenTrade, trade)) {
            return '';
        }

        return `<span class="exit-reason-badge exit-reason-badge--polymarket-open" title="Poly open: Worker-backed live subscription confirms this trade is still open.">Poly open</span>`;
    }

    private resolveWorkerBackedOpenPolymarketPosition(): LivePosition | null {
        if (state.currentBacktestResultSource !== "backtest") {
            return null;
        }

        const summary = state.currentBacktestResult?.polymarketTradeSummary;
        if (summary?.evaluationMode !== "signal_exit_same_event") {
            return null;
        }

        if (!livePositionsService.isPolling()) {
            return null;
        }

        const livePositionsState = livePositionsService.getState();
        if (
            livePositionsState.lastPollTime === null
            || Date.now() - livePositionsState.lastPollTime > TradesRenderer.LIVE_POSITION_STALE_AFTER_MS
        ) {
            return null;
        }

        const currentAlertContext = resolveCurrentAlertSubscriptionContext();
        if (!currentAlertContext) {
            return null;
        }

        const livePosition = livePositionsState.positions.find((position) => position.streamId === currentAlertContext.streamId);
        if (!livePosition || !livePosition.isOpen || livePosition.mismatch) {
            return null;
        }

        return livePosition;
    }

    private tradesMatchForLiveOpenBadge(expectedOpenTrade: Trade, currentTrade: Trade): boolean {
        if (expectedOpenTrade.type !== currentTrade.type) {
            return false;
        }

        const expectedEntryTs = parseTimeToUnixSeconds(expectedOpenTrade.entryTime);
        const currentEntryTs = parseTimeToUnixSeconds(currentTrade.entryTime);
        if (expectedEntryTs !== null && currentEntryTs !== null && expectedEntryTs !== currentEntryTs) {
            return false;
        }

        return Math.abs(expectedOpenTrade.entryPrice - currentTrade.entryPrice) < 1e-9;
    }

    private isCurrentSignalExitPolymarketTradeInCurrentBucket(trade: Trade): boolean {
        const result = state.currentBacktestResult;
        if (!result || result.polymarketTradeSummary?.evaluationMode !== "signal_exit_same_event") {
            return false;
        }

        const currentBucketStart = this.resolveCurrentPolymarketEventStartTs();
        if (currentBucketStart === null) {
            return false;
        }

        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            return false;
        }

        return Math.floor(entryTs / 300) * 300 === currentBucketStart;
    }

    private resolveCurrentPolymarketEventStartTs(): number | null {
        const latestBar = state.ohlcvData[state.ohlcvData.length - 1];
        const latestBarTs = latestBar ? parseTimeToUnixSeconds(latestBar.time) : null;
        if (latestBarTs !== null) {
            return Math.floor(latestBarTs / 300) * 300;
        }

        const latestTradeTs = [...(state.currentBacktestResult?.trades ?? [])]
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null)
            .pop();
        if (latestTradeTs === undefined) {
            return null;
        }

        return Math.floor(latestTradeTs / 300) * 300;
    }
    private formatPolymarketEntryPrice(price: number): string {
        return `${(price * 100).toFixed(1)}c`;
    }

    private formatPolymarketSizedMoney(value: number): string {
        const sign = value > 0 ? '+' : value < 0 ? '-' : '';
        return `${sign}$${Math.abs(value).toFixed(2)}`;
    }

    private getPolymarketSizingRow(trade: Trade): string {
        const outcome = trade.polymarketOutcome;
        if (!outcome) {
            return '';
        }
        const { sizedStake, sizedShares, sizedPnl, sizedPnlPercent, marketEntryPrice } = outcome;
        if (
            typeof sizedStake !== 'number'
            || !Number.isFinite(sizedStake)
            || typeof sizedShares !== 'number'
            || !Number.isFinite(sizedShares)
            || typeof sizedPnl !== 'number'
            || !Number.isFinite(sizedPnl)
            || typeof marketEntryPrice !== 'number'
            || !Number.isFinite(marketEntryPrice)
        ) {
            return '';
        }

        const pnlClass = sizedPnl > 0 ? 'positive' : sizedPnl < 0 ? 'negative' : '';
        const pctLabel = typeof sizedPnlPercent === 'number' && Number.isFinite(sizedPnlPercent)
            ? ` (${sizedPnlPercent >= 0 ? '+' : ''}${sizedPnlPercent.toFixed(2)}%)`
            : '';
        const cappedLabel = outcome.sizedStakeCapped ? ' | capped' : '';
        return `
                            <div class="trade-sub-info">
                                <span class="trade-size">Poly Stake: $${sizedStake.toFixed(2)} | Shares: ${sizedShares.toFixed(2)} @ ${this.formatPolymarketEntryPrice(marketEntryPrice)} | Profit: <span class="${pnlClass}">${this.formatPolymarketSizedMoney(sizedPnl)}${pctLabel}</span>${cappedLabel}</span>
                            </div>
        `;
    }

    private formatPolymarketExitTime(ts: number | null | undefined): string {
        if (typeof ts !== 'number' || !Number.isFinite(ts)) {
            return 'n/a';
        }

        return new Date(ts * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    private encodeTradeEntryTime(time: Time): string {
        return encodeURIComponent(JSON.stringify(time));
    }

    private renderTradeItemsProgressively(
        renderGeneration: number,
        container: HTMLElement,
        trades: Trade[],
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): void {
        const reversed = trades.slice().reverse();
        const toRender = reversed.slice(0, TradesRenderer.MAX_TRADES);
        const initialCount = Math.min(toRender.length, TradesRenderer.INITIAL_RENDER_BATCH_SIZE);
        container.innerHTML = this.renderTradeChunk(toRender, 0, initialCount, formatPrice, formatDate);

        let offset = initialCount;
        const appendLimitNotice = () => {
            if (renderGeneration !== this.tradeRenderGeneration || trades.length <= TradesRenderer.MAX_TRADES) {
                return;
            }

            const fragment = document.createRange().createContextualFragment(
                this.renderTradesLimitNotice(trades.length)
            );
            container.appendChild(fragment);
        };

        if (offset >= toRender.length) {
            appendLimitNotice();
            return;
        }

        const appendChunk = () => {
            if (renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const nextOffset = Math.min(offset + TradesRenderer.DEFERRED_RENDER_BATCH_SIZE, toRender.length);
            const fragment = document.createRange().createContextualFragment(
                this.renderTradeChunk(toRender, offset, nextOffset, formatPrice, formatDate)
            );
            container.appendChild(fragment);
            offset = nextOffset;

            if (offset < toRender.length) {
                this.scheduleDeferredRender(appendChunk);
                return;
            }

            appendLimitNotice();
        };

        this.scheduleDeferredRender(appendChunk);
    }

    private renderTradeChunk(
        trades: Trade[],
        startIndex: number,
        endIndex: number,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): string {
        let html = '';
        for (let index = startIndex; index < endIndex; index += 1) {
            html += this.renderTradeItem(trades[index], formatPrice, formatDate);
        }
        return html;
    }

    private renderTradesLimitNotice(totalTrades: number): string {
        return `<div class="trades-limit-notice" style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.9em; border-top: 1px solid var(--border-color);">Showing most recent ${TradesRenderer.MAX_TRADES} of ${totalTrades} trades</div>`;
    }

    private scheduleDeferredRender(callback: () => void): void {
        if (typeof window.requestIdleCallback === 'function') {
            const deferredId = window.requestIdleCallback(() => callback());
            this.pendingDeferredRenderIds.push(deferredId);
            return;
        }

        const deferredId = window.setTimeout(callback, 16);
        this.pendingDeferredRenderIds.push(deferredId);
    }

    private cancelPendingDeferredRenders(): void {
        for (const deferredId of this.pendingDeferredRenderIds) {
            if (typeof window.cancelIdleCallback === 'function') {
                window.cancelIdleCallback(deferredId);
            } else {
                window.clearTimeout(deferredId);
            }
        }
        this.pendingDeferredRenderIds = [];
    }

    private renderTradeItem(trade: Trade, formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        const display = this.getDisplayTradeMetrics(trade);
        const isProfit = display.pnl >= 0;
        const statusClass = isProfit ? 'win' : 'loss';
        const duration = this.formatDuration(display.durationMs);
        const fees = trade.fees ? `Fees: $${trade.fees.toFixed(2)}` : '';
        const entryValue = trade.size * trade.entryPrice;
        const sizeLabel = Number.isFinite(entryValue) && entryValue > 0
            ? `Entry Value: $${entryValue.toFixed(2)} | Qty: ${trade.size.toFixed(4)}`
            : `Qty: ${trade.size.toFixed(4)}`;
        const exitReasonBadge = this.getExitReasonBadge(display.displayExitReason);
        const polymarketOutcomeBadge = this.getPolymarketOutcomeBadge(trade);
        const polymarketSizingRow = this.getPolymarketSizingRow(trade);
        const chartSizeRow = trade.polymarketOutcome
            ? ''
            : `
                            <div class="trade-sub-info">
                                <span class="trade-size">${sizeLabel}</span>
                            </div>
            `;
        const entryDate = formatDate(trade.entryTime);

        let targetRow = '';
        if (display.displayExitReason === 'end_of_data') {
            const targets: string[] = [];
            if (trade.takeProfitPrice != null && trade.takeProfitPrice > 0) {
                const tpPct = Math.abs((trade.takeProfitPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target tp" title="Take Profit target">TP: ${formatPrice(trade.takeProfitPrice)} <span class="target-pct">(${tpPct.toFixed(2)}%)</span></span>`);
            }
            if (trade.stopLossPrice != null && trade.stopLossPrice > 0) {
                const slPct = Math.abs((trade.stopLossPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target sl" title="Stop Loss target">SL: ${formatPrice(trade.stopLossPrice)} <span class="target-pct">(${slPct.toFixed(2)}%)</span></span>`);
            }
            if (targets.length > 0) {
                targetRow = `<div class="trade-targets-row">${targets.join('')}</div>`;
            }
        }

        return `
            <div class="trade-item ${statusClass}" data-entry-time="${this.encodeTradeEntryTime(trade.entryTime)}" role="button" tabindex="0">
                <div class="trade-main-row">
                    <div class="trade-left-group">
                        <div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
                            ${trade.type === 'long' ? 'B' : 'S'}
                        </div>
                        <div class="trade-price-info">
                            <div class="trade-price-flow">
                                <span class="price-val">${formatPrice(trade.entryPrice)}</span>
                                <span class="price-arrow">-></span>
                                <span class="price-val">${formatPrice(display.exitPrice)}</span>
                            </div>
                            <div class="trade-sub-info">
                                 <span class="trade-time">${entryDate}</span>
                                 <span class="separator">|</span>
                                 <span class="trade-duration">${duration}</span>
                                 ${exitReasonBadge}
                                 ${polymarketOutcomeBadge}
                                 ${fees ? `<span class="separator">|</span><span class="trade-fees">${fees}</span>` : ''}
                             </div>
                            ${chartSizeRow}
                            ${polymarketSizingRow}
                        </div>
                    </div>
                    <div class="trade-result-group">
                        <div class="trade-pnl">
                            ${isProfit ? '+' : ''}$${display.pnl.toFixed(2)}
                        </div>
                        <div class="trade-pct">
                            ${Math.abs(display.pnlPercent).toFixed(2)}%
                        </div>
                    </div>
                </div>
                ${targetRow}
            </div>
        `;
    }

    private getDisplayTradeMetrics(trade: Trade): {
        exitPrice: number;
        pnl: number;
        pnlPercent: number;
        durationMs: number;
        displayExitReason: Trade['exitReason'];
    } {
        const liveCandle: OHLCVData | null = state.ohlcvData.length > 0
            ? state.ohlcvData[state.ohlcvData.length - 1]
            : null;

        return resolveOpenTradeDisplayMetrics(trade, liveCandle);
    }

    private ensureTradeJumpHandlersBound(): void {
        if (this.jumpHandlersBound) {
            return;
        }

        const container = this.getDom().tradesList;
        container.addEventListener('click', (event) => {
            const copyTarget = this.resolvePolymarketCopyTarget(event.target, container);
            if (copyTarget) {
                event.preventDefault();
                void this.copyPolymarketUrl(copyTarget.dataset.polymarketUrl ?? '');
                return;
            }

            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }
            this.activateTradeItem(item);
        });
        container.addEventListener('keydown', (event) => {
            const copyTarget = this.resolvePolymarketCopyTarget(event.target, container);
            if (copyTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                void this.copyPolymarketUrl(copyTarget.dataset.polymarketUrl ?? '');
                return;
            }

            if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }

            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }

            event.preventDefault();
            this.activateTradeItem(item);
        });
        this.jumpHandlersBound = true;
    }

    private resolvePolymarketCopyTarget(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }

        const badge = target.closest('[data-polymarket-url]');
        if (!(badge instanceof HTMLElement) || !container.contains(badge)) {
            return null;
        }

        return badge;
    }

    private async copyPolymarketUrl(url: string): Promise<void> {
        if (!url || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
            return;
        }

        try {
            await navigator.clipboard.writeText(url);
        } catch {
            // Ignore clipboard failures to avoid breaking trade navigation.
        }
    }

    private resolveTradeItemTarget(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }

        const item = target.closest('.trade-item');
        if (!(item instanceof HTMLElement) || !container.contains(item)) {
            return null;
        }

        return item;
    }

    private activateTradeItem(item: HTMLElement): void {
        const encodedEntryTime = item.dataset.entryTime;
        if (!encodedEntryTime || !this.jumpToTrade) {
            return;
        }

        try {
            const entryTime = JSON.parse(decodeURIComponent(encodedEntryTime)) as Time;
            this.jumpToTrade(entryTime);
        } catch {
            // Ignore malformed attributes rather than breaking the trade list.
        }
    }

    private buildPolymarketMarketUrl(marketSlug: string): string {
        return `https://polymarket.com/event/${marketSlug}`;
    }

    private updateSummary(trades: Trade[]) {
        const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winners = trades.filter(t => t.pnl > 0).length;
        const winRate = (winners / trades.length) * 100;
        const dom = this.getDom();

        dom.tradesTotalPnL.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`;
        dom.tradesTotalPnL.className = `summary-value ${totalPnL >= 0 ? 'positive' : 'negative'}`;
        dom.tradesWinRate.textContent = `${winRate.toFixed(1)}%`;
        dom.tradesWinRate.className = `summary-value ${winRate >= 50 ? 'positive' : 'negative'}`;
    }

    public clear() {
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        setVisible('emptyTrades', true);
        setVisible('tradesSummary', false);
        const container = this.getDom().tradesList;
        container.classList.remove('trades-list-parity');
        container.innerHTML = '';
    }
}

export const tradesRenderer = new TradesRenderer();
