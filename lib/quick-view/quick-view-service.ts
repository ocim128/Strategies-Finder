import { ensureLazyStylesheet } from "../lazy-styles";
import { state } from "../state";
import type { BacktestResult, ExpectancyBreakdownSection, Trade } from "../strategies/index";
import type { Time } from "lightweight-charts";
import {
    getChartWrapper,
    getQuickViewBtn,
    getQvStatsContent,
    getQvEmpty,
    getQvTradesList,
    getQvTradesCount,
    getQvSortLabel,
    QV_IDS,
} from "./quick-view-dom";
import {
    buildShell,
    renderResultsHtml,
    renderTradeChunkHtml,
    renderTradesLimitNoticeHtml,
    renderEmptyTradesHtml,
} from "./quick-view-renderer";
import { cancelIdleBatched, scheduleIdleBatched } from "../render-scheduler";


export function getQuickViewDiagnosticSections(result: BacktestResult): ExpectancyBreakdownSection[] {
    const sections = result.expectancyBreakdown?.sections ?? [];
    return sections.filter((section) => (
        section.id === "session_minute" || section.id === "price_range_position"
    ));
}

class QuickViewManager {
    private static readonly MAX_RENDERED_TRADES = 100;
    private static readonly INITIAL_TRADE_BATCH_SIZE = 40;
    private static readonly DEFERRED_TRADE_BATCH_SIZE = 80;

    private overlay: HTMLElement | null = null;
    private enabled = true;
    private visible = false;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private sortNewestFirst = true;
    private currentTrades: Trade[] = [];
    private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;
    private tradeRenderGeneration = 0;
    private pendingDeferredRenderIds: Array<ReturnType<typeof scheduleIdleBatched>> = [];
    private overlayRenderGeneration = 0;

    init() {
        ensureLazyStylesheet("quick-view-styles", new URL("../../styles/quick-view.css", import.meta.url).href);
        this.injectOverlay();
        this.bindToolbarButton();
        this.bindKeyboard();
    }

    private injectOverlay() {
        const chartWrapper = getChartWrapper();
        if (!chartWrapper) return;

        const el = document.createElement('div');
        el.className = 'quick-view-overlay';
        el.id = QV_IDS.overlay;
        el.innerHTML = buildShell();
        chartWrapper.appendChild(el);
        this.overlay = el;

        el.querySelector('#' + QV_IDS.closeBtn)?.addEventListener('click', () => this.hide());

        el.querySelector('#' + QV_IDS.sortToggle)?.addEventListener('click', () => {
            this.sortNewestFirst = !this.sortNewestFirst;
            this.renderTrades(this.currentTrades);
        });

        const tradesList = el.querySelector<HTMLElement>('#' + QV_IDS.tradesList);
        tradesList?.addEventListener('click', (event) => {
            this.handleTradeItemActivation(event.target, tradesList);
        });
        tradesList?.addEventListener('keydown', (event) => {
            if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }

            event.preventDefault();
            this.handleTradeItemActivation(event.target, tradesList);
        });
    }

    private bindToolbarButton() {
        const btn = getQuickViewBtn();
        if (!btn) return;

        btn.classList.toggle('qv-active', this.enabled);

        btn.addEventListener('click', () => {
            if (this.visible) {
                this.hide();
            } else {
                if (state.currentBacktestResult) {
                    this.show(state.currentBacktestResult);
                } else {
                    this.enabled = !this.enabled;
                    btn.classList.toggle('qv-active', this.enabled);
                }
            }
        });
    }

    private bindKeyboard() {
        this.keyboardHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.visible) {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
            }
        };

        window.addEventListener('keydown', this.keyboardHandler);
    }

    async show(result: BacktestResult) {
        if (!this.overlay) return;

        this.renderResults(result);
        this.renderTrades(result.trades);

        this.overlay.style.display = 'flex';
        this.overlay.offsetHeight;
        this.overlay.classList.add('is-visible');
        this.visible = true;

        const btn = getQuickViewBtn();
        if (btn) btn.classList.add('qv-active');
    }

    hide() {
        if (!this.overlay) return;
        this.overlayRenderGeneration += 1;

        this.overlay.classList.remove('is-visible');
        setTimeout(() => {
            if (this.overlay && !this.overlay.classList.contains('is-visible')) {
                this.overlay.style.display = 'none';
            }
        }, 260);
        this.visible = false;

        const btn = getQuickViewBtn();
        if (btn) btn.classList.toggle('qv-active', this.enabled);
    }

    async onBacktestComplete(result: BacktestResult) {
        if (this.enabled) {
            await this.show(result);
        }
    }

    setJumpToTrade(fn: (time: Time) => void) {
        this.jumpToTrade = fn;
    }

    get isVisible() {
        return this.visible;
    }

    destroy() {
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        this.overlayRenderGeneration += 1;
        if (this.keyboardHandler) {
            window.removeEventListener('keydown', this.keyboardHandler);
            this.keyboardHandler = null;
        }
        if (this.overlay?.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.visible = false;
    }

    private renderResults(result: BacktestResult) {
        const content = getQvStatsContent();
        const empty = getQvEmpty();
        if (!content || !empty) return;

        empty.style.display = 'none';
        content.style.display = 'block';

        content.innerHTML = renderResultsHtml(result);
    }

    private renderTrades(trades: Trade[]) {
        this.currentTrades = trades;
        const list = getQvTradesList();
        const count = getQvTradesCount();
        const sortLabel = getQvSortLabel();
        if (!list) return;
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        if (count) count.textContent = String(trades.length);
        if (sortLabel) sortLabel.textContent = this.sortNewestFirst ? 'Newest first' : 'Oldest first';

        if (trades.length === 0) {
            list.innerHTML = renderEmptyTradesHtml();
            return;
        }

        const sorted = this.sortNewestFirst ? [...trades].reverse() : trades;
        const toRender = sorted.slice(0, QuickViewManager.MAX_RENDERED_TRADES);
        const limitNotice = trades.length > QuickViewManager.MAX_RENDERED_TRADES
            ? renderTradesLimitNoticeHtml(trades.length, QuickViewManager.MAX_RENDERED_TRADES)
            : '';
        this.renderTradesProgressively(this.tradeRenderGeneration, list, toRender, limitNotice);
    }

    private renderTradesProgressively(
        renderGeneration: number,
        list: HTMLElement,
        trades: Trade[],
        limitNoticeHtml: string
    ): void {
        const initialCount = Math.min(trades.length, QuickViewManager.INITIAL_TRADE_BATCH_SIZE);
        list.innerHTML = renderTradeChunkHtml(trades, 0, initialCount);

        let offset = initialCount;
        const appendLimitNotice = () => {
            if (!limitNoticeHtml || renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const fragment = document.createRange().createContextualFragment(limitNoticeHtml);
            list.appendChild(fragment);
        };

        if (offset >= trades.length) {
            appendLimitNotice();
            return;
        }

        const appendChunk = () => {
            if (renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const nextOffset = Math.min(offset + QuickViewManager.DEFERRED_TRADE_BATCH_SIZE, trades.length);
            const fragment = document.createRange().createContextualFragment(
                renderTradeChunkHtml(trades, offset, nextOffset)
            );
            list.appendChild(fragment);
            offset = nextOffset;

            if (offset < trades.length) {
                this.scheduleDeferredRender(appendChunk);
                return;
            }

            appendLimitNotice();
        };

        this.scheduleDeferredRender(appendChunk);
    }

    private handleTradeItemActivation(target: EventTarget | null, list: HTMLElement): void {
        if (!(target instanceof Element)) {
            return;
        }

        const item = target.closest('.qv-trade-item');
        if (!(item instanceof HTMLElement) || !list.contains(item)) {
            return;
        }

        const raw = item.dataset.entryTime;
        if (!raw || !this.jumpToTrade) {
            return;
        }

        this.jumpToTrade(this.parseTradeTime(raw));
        this.hide();
    }

    private parseTradeTime(raw: string): Time {
        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            decoded = raw;
        }

        try {
            return JSON.parse(decoded) as Time;
        } catch {
            return (isNaN(Number(decoded)) ? decoded : Number(decoded)) as Time;
        }
    }

    private scheduleDeferredRender(callback: () => void): void {
        this.pendingDeferredRenderIds.push(scheduleIdleBatched(callback));
    }

    private cancelPendingDeferredRenders(): void {
        for (const deferredId of this.pendingDeferredRenderIds) {
            cancelIdleBatched(deferredId);
        }
        this.pendingDeferredRenderIds = [];
    }

}

export const quickViewManager = new QuickViewManager();
