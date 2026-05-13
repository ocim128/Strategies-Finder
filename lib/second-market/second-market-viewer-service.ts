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
    type SecondMarketViewerCandle,
    type SecondMarketViewerClobQuote,
    type SecondMarketViewerGammaSnapshot,
    type SecondMarketViewerReferencePrice,
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

function formatPrice(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
        ? "--"
        : value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatQuantity(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value)
        ? "--"
        : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
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

function formatDateTimeInputValue(ts: number): string {
    const date = new Date(Math.floor(ts) * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ].join("T");
}

function parseDateTimeInputValue(value: string): number | null {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function timeToSecond(time: Time | undefined): number | null {
    return typeof time === "number" && Number.isFinite(time) ? Math.floor(time) : null;
}

function latestQuote(rows: readonly SecondMarketViewerClobQuote[]): SecondMarketViewerClobQuote | null {
    return rows.length > 0 ? rows[rows.length - 1]! : null;
}

function exactQuoteAt(rows: readonly SecondMarketViewerClobQuote[], ts: number): SecondMarketViewerClobQuote | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.sample_ts === ts) return row;
        if (row.sample_ts < ts) return null;
    }
    return null;
}

function exactReferenceAt(
    rows: readonly SecondMarketViewerReferencePrice[],
    ts: number
): SecondMarketViewerReferencePrice | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.ts === ts) return row;
        if (row.ts < ts) return null;
    }
    return null;
}

function candleAt(rows: readonly SecondMarketViewerCandle[], ts: number): SecondMarketViewerCandle | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.ts === ts) return row;
        if (row.ts < ts) return null;
    }
    return null;
}

function gammaAt(
    rows: readonly SecondMarketViewerGammaSnapshot[],
    ts: number
): SecondMarketViewerGammaSnapshot | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.event_start_ts <= ts && row.event_end_ts > ts && row.snapshot_ts <= ts) return row;
    }
    return null;
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
    private lastData: SecondMarketViewerWindow | null = null;
    private selectedTs: number | null = null;

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
        this.bindCrosshairInspectors();
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
        dom.inspectGoButton.addEventListener("click", () => void this.inspectInputSecond());
        dom.inspectSecondInput.addEventListener("change", () => void this.inspectInputSecond());
        dom.inspectSecondInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") void this.inspectInputSecond();
        });
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

    private bindCrosshairInspectors(): void {
        const charts = this.charts;
        if (!charts) return;
        for (const chart of [charts.binanceChart, charts.clobChart, charts.referenceChart]) {
            chart.subscribeCrosshairMove((param) => {
                const ts = timeToSecond(param.time);
                if (ts === null) return;
                this.selectSecond(ts);
            });
        }
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

    private async inspectInputSecond(): Promise<void> {
        const dom = this.dom;
        if (!dom) return;
        const ts = parseDateTimeInputValue(dom.inspectSecondInput.value);
        if (ts === null) {
            this.setStatus("Invalid selected second.", "error");
            return;
        }

        const data = this.lastData;
        this.selectedTs = ts;
        if (!data || ts < data.startTs || ts > data.endTs) {
            await this.refresh(ts);
            return;
        }
        this.selectSecond(ts);
    }

    async refresh(endTs?: number): Promise<void> {
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
                endTs,
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
        this.lastData = data;

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

        const fallbackSelectedTs = this.selectedTs !== null && this.selectedTs >= data.startTs && this.selectedTs <= data.endTs
            ? this.selectedTs
            : data.stats.latestDataTs ?? data.candles[data.candles.length - 1]?.ts ?? data.endTs;
        this.selectSecond(fallbackSelectedTs);
    }

    private selectSecond(ts: number): void {
        const dom = this.dom;
        const data = this.lastData;
        if (!dom || !data || !Number.isFinite(ts)) return;

        const selectedTs = Math.floor(ts);
        this.selectedTs = selectedTs;
        dom.inspectSecondInput.value = formatDateTimeInputValue(selectedTs);
        dom.detailTime.textContent = `${formatDateTime(selectedTs)} (${selectedTs})`;

        const candle = candleAt(data.candles, selectedTs);
        const quote = exactQuoteAt(data.clobQuotes, selectedTs);
        const reference = exactReferenceAt(data.referencePrices, selectedTs);
        const gamma = gammaAt(data.gammaSnapshots, selectedTs);

        dom.detailBinance.textContent = candle
            ? `O ${formatPrice(candle.open)} H ${formatPrice(candle.high)} L ${formatPrice(candle.low)} C ${formatPrice(candle.close)}`
            : "missing";
        dom.detailVolume.textContent = candle
            ? `${formatQuantity(candle.volume)} / ${candle.trade_count ?? "--"}`
            : "missing";
        dom.detailYes.textContent = quote
            ? `B ${formatProbability(quote.yes_bid)} A ${formatProbability(quote.yes_ask)} M ${formatProbability(quote.yes_mid)} L ${formatProbability(quote.yes_last)}`
            : "missing";
        dom.detailNo.textContent = quote
            ? `B ${formatProbability(quote.no_bid)} A ${formatProbability(quote.no_ask)} M ${formatProbability(quote.no_mid)} L ${formatProbability(quote.no_last)}`
            : "missing";
        dom.detailReference.textContent = reference
            ? `${formatPrice(reference.reference_price)} ${reference.is_carried_forward ? "carried" : "live"}`
            : "missing";
        dom.detailGamma.textContent = gamma
            ? `Y ${formatProbability(gamma.gamma_yes_price)} N ${formatProbability(gamma.gamma_no_price)} L ${formatProbability(gamma.last_trade_price)} @ ${formatDateTime(gamma.snapshot_ts)}`
            : "--";

        const alignment: string[] = [];
        if (!candle) alignment.push("missing Binance");
        if (!quote) alignment.push("missing CLOB");
        if (!reference) alignment.push("missing reference");
        if (quote?.quote_age_ms !== null && quote?.quote_age_ms !== undefined) {
            alignment.push(`quote age ${formatSeconds(quote.quote_age_ms / 1000)}`);
        }
        const flags = [quote?.quality_flags, reference?.quality_flags]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .join(" | ");
        if (flags) alignment.push(flags);
        dom.detailAlignment.textContent = alignment.length > 0 ? alignment.join(" | ") : "exact second";
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
