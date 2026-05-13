import {
    CandlestickSeries,
    createChart,
    LineSeries,
    type IChartApi,
    type ISeriesApi,
    type Time,
} from "lightweight-charts";
import { darkTheme, ENHANCED_CANDLE_COLORS } from "../constants";
import { state } from "../state";
import {
    loadSecondMarketViewerWindow,
    type SecondMarketViewerClobQuote,
    type SecondMarketViewerSymbol,
    type SecondMarketViewerWindow,
} from "./second-market-viewer-api";
import { querySecondMarketViewerDom, type SecondMarketViewerDom } from "./second-market-viewer-dom";

type ViewerCharts = {
    binanceChart: IChartApi;
    clobChart: IChartApi;
    referenceChart: IChartApi;
    candleSeries: ISeriesApi<"Candlestick">;
    yesBidSeries: ISeriesApi<"Line">;
    yesAskSeries: ISeriesApi<"Line">;
    noBidSeries: ISeriesApi<"Line">;
    noAskSeries: ISeriesApi<"Line">;
    referenceSeries: ISeriesApi<"Line">;
};

const REFRESH_MS = 5000;

function formatInteger(value: number): string {
    return Number.isFinite(value) ? Math.floor(value).toLocaleString("en-US") : "--";
}

function formatPercent(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
        ? "--"
        : `${value.toFixed(1)}%`;
}

function formatSeconds(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
        ? "--"
        : `${Math.floor(value)}s`;
}

function formatProbability(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
        ? "--"
        : value.toFixed(3);
}

function formatDateTime(ts: number | null | undefined): string {
    if (ts === null || ts === undefined || !Number.isFinite(ts)) return "--";
    return new Date(Math.floor(ts) * 1000).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function latestQuote(rows: readonly SecondMarketViewerClobQuote[]): SecondMarketViewerClobQuote | null {
    return rows.length > 0 ? rows[rows.length - 1]! : null;
}

function statusTone(data: SecondMarketViewerWindow): "good" | "warning" | "error" {
    if (data.candles.length === 0 || data.clobQuotes.length === 0) return "error";
    if ((data.stats.latestLagSec ?? 0) > 45) return "warning";
    if ((data.stats.maxQuoteAgeSec ?? 0) > 20) return "warning";
    if (data.stats.overlapSeconds > 0 && data.stats.exactSampleCoveragePct < 95) return "warning";
    return "good";
}

function statusText(data: SecondMarketViewerWindow): string {
    const start = formatDateTime(data.stats.overlapStartTs);
    const end = formatDateTime(data.stats.overlapEndTs);
    return `${data.symbol} ${data.startTs}-${data.endTs} | overlap ${start} to ${end}`;
}

export class SecondMarketViewerService {
    private dom: SecondMarketViewerDom | null = null;
    private charts: ViewerCharts | null = null;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private loading = false;
    private initialized = false;

    init(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.dom = querySecondMarketViewerDom();
        this.syncSymbolFromState();
        this.createCharts();
        this.bindEvents();
        this.startAutoRefresh();
        void this.refresh();
    }

    private syncSymbolFromState(): void {
        const dom = this.dom;
        if (!dom) return;
        const current = state.currentSymbol === "BTCUSDT" || state.currentSymbol === "XRPUSDT"
            ? state.currentSymbol
            : "BTCUSDT";
        dom.symbolSelect.value = current;
    }

    private createCharts(): void {
        const dom = this.dom;
        if (!dom || this.charts) return;

        const baseOptions = {
            ...darkTheme,
            autoSize: true,
            timeScale: {
                ...darkTheme.timeScale,
                secondsVisible: true,
                timeVisible: true,
                minBarSpacing: 4,
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                vertTouchDrag: true,
                horzTouchDrag: true,
            },
        };

        const binanceChart = createChart(dom.binanceChart, baseOptions);
        const clobChart = createChart(dom.clobChart, {
            ...baseOptions,
            rightPriceScale: {
                borderColor: "#2a2e39",
                scaleMargins: { top: 0.08, bottom: 0.08 },
            },
        });
        const referenceChart = createChart(dom.referenceChart, baseOptions);

        const candleSeries = binanceChart.addSeries(CandlestickSeries, {
            upColor: ENHANCED_CANDLE_COLORS.up,
            downColor: ENHANCED_CANDLE_COLORS.down,
            borderUpColor: ENHANCED_CANDLE_COLORS.upBorder,
            borderDownColor: ENHANCED_CANDLE_COLORS.downBorder,
            wickUpColor: ENHANCED_CANDLE_COLORS.wickUp,
            wickDownColor: ENHANCED_CANDLE_COLORS.wickDown,
        });
        const yesBidSeries = clobChart.addSeries(LineSeries, {
            color: "#00c087",
            lineWidth: 2,
            priceLineVisible: false,
            priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        const yesAskSeries = clobChart.addSeries(LineSeries, {
            color: "#7aa2ff",
            lineWidth: 1,
            priceLineVisible: false,
            priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        const noBidSeries = clobChart.addSeries(LineSeries, {
            color: "#f5b642",
            lineWidth: 2,
            priceLineVisible: false,
            priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        const noAskSeries = clobChart.addSeries(LineSeries, {
            color: "#ff6b7d",
            lineWidth: 1,
            priceLineVisible: false,
            priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        const referenceSeries = referenceChart.addSeries(LineSeries, {
            color: "#6ee7b7",
            lineWidth: 2,
            priceLineVisible: false,
        });

        this.charts = {
            binanceChart,
            clobChart,
            referenceChart,
            candleSeries,
            yesBidSeries,
            yesAskSeries,
            noBidSeries,
            noAskSeries,
            referenceSeries,
        };
        this.syncTimeScales();
    }

    private syncTimeScales(): void {
        const charts = this.charts;
        if (!charts) return;
        let syncing = false;
        const allCharts = [charts.binanceChart, charts.clobChart, charts.referenceChart];
        for (const chart of allCharts) {
            chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
                if (syncing || !range) return;
                syncing = true;
                for (const target of allCharts) {
                    if (target !== chart) target.timeScale().setVisibleLogicalRange(range);
                }
                syncing = false;
            });
        }
    }

    private bindEvents(): void {
        const dom = this.dom;
        if (!dom) return;
        dom.refreshButton.addEventListener("click", () => void this.refresh());
        dom.symbolSelect.addEventListener("change", () => void this.refresh());
        dom.windowSelect.addEventListener("change", () => void this.refresh());
        dom.autoRefreshInput.addEventListener("change", () => {
            if (dom.autoRefreshInput.checked) this.startAutoRefresh();
            else this.stopAutoRefresh();
        });
        window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId: string }>) => {
            if (event.detail.tabId === "secondmarket") {
                requestAnimationFrame(() => {
                    this.charts?.binanceChart.timeScale().fitContent();
                    this.charts?.clobChart.timeScale().fitContent();
                    this.charts?.referenceChart.timeScale().fitContent();
                });
            }
        }) as EventListener);
    }

    private startAutoRefresh(): void {
        if (this.refreshTimer) return;
        this.refreshTimer = setInterval(() => {
            const dom = this.dom;
            if (!dom || dom.tab.hidden || !dom.autoRefreshInput.checked) return;
            void this.refresh();
        }, REFRESH_MS);
    }

    private stopAutoRefresh(): void {
        if (!this.refreshTimer) return;
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    private setStatus(text: string, tone: "good" | "warning" | "error" | "neutral" = "neutral"): void {
        const status = this.dom?.status;
        if (!status) return;
        status.textContent = text;
        status.classList.toggle("is-good", tone === "good");
        status.classList.toggle("is-warning", tone === "warning");
        status.classList.toggle("is-error", tone === "error");
    }

    async refresh(): Promise<void> {
        const dom = this.dom;
        const charts = this.charts;
        if (!dom || !charts || this.loading) return;

        this.loading = true;
        dom.refreshButton.disabled = true;
        this.setStatus("Loading");
        try {
            const data = await loadSecondMarketViewerWindow({
                symbol: dom.symbolSelect.value as SecondMarketViewerSymbol,
                windowSec: Number(dom.windowSelect.value),
            });
            this.render(data);
            this.setStatus(statusText(data), statusTone(data));
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), "error");
        } finally {
            this.loading = false;
            dom.refreshButton.disabled = false;
        }
    }

    private render(data: SecondMarketViewerWindow): void {
        const charts = this.charts;
        const dom = this.dom;
        if (!charts || !dom) return;

        charts.candleSeries.setData(data.candles.map((row) => ({
            time: row.ts as Time,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
        })));
        charts.yesBidSeries.setData(this.lineData(data.clobQuotes, "yes_bid"));
        charts.yesAskSeries.setData(this.lineData(data.clobQuotes, "yes_ask"));
        charts.noBidSeries.setData(this.lineData(data.clobQuotes, "no_bid"));
        charts.noAskSeries.setData(this.lineData(data.clobQuotes, "no_ask"));
        charts.referenceSeries.setData(data.referencePrices.map((row) => ({
            time: row.ts as Time,
            value: row.reference_price,
        })));

        charts.binanceChart.timeScale().fitContent();
        charts.clobChart.timeScale().fitContent();
        charts.referenceChart.timeScale().fitContent();

        const lastQuote = latestQuote(data.clobQuotes);
        const latestGamma = data.gammaSnapshots[data.gammaSnapshots.length - 1] ?? null;
        dom.metricBinance.textContent = formatInteger(data.stats.binanceSeconds);
        dom.metricClob.textContent = formatInteger(data.stats.clobSeconds);
        dom.metricReference.textContent = formatInteger(data.stats.referenceSeconds);
        dom.metricCoverage.textContent = formatPercent(data.stats.exactSampleCoveragePct);
        dom.metricQuoteAge.textContent = formatSeconds(data.stats.maxQuoteAgeSec);
        dom.metricLag.textContent = formatSeconds(data.stats.latestLagSec);
        dom.activeEvent.textContent = data.stats.activeMarketSlug ?? "--";
        dom.latestTime.textContent = formatDateTime(data.stats.latestDataTs);
        dom.gammaYes.textContent = formatProbability(latestGamma?.gamma_yes_price ?? lastQuote?.yes_mid ?? null);
        dom.gammaNo.textContent = formatProbability(latestGamma?.gamma_no_price ?? lastQuote?.no_mid ?? null);
    }

    private lineData(
        rows: readonly SecondMarketViewerClobQuote[],
        key: "yes_bid" | "yes_ask" | "no_bid" | "no_ask"
    ): Array<{ time: Time; value: number }> {
        return rows
            .map((row) => {
                const value = row[key];
                return value === null || value === undefined || !Number.isFinite(value)
                    ? null
                    : { time: row.sample_ts as Time, value };
            })
            .filter((row): row is { time: Time; value: number } => row !== null);
    }
}

export const secondMarketViewerService = new SecondMarketViewerService();
