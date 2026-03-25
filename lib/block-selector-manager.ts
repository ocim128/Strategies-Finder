import { createSeriesMarkers, ISeriesMarkersPluginApi, SeriesMarker, Time } from "lightweight-charts";
import { state } from "./state";
import { getRequiredElement, setVisible } from "./dom-utils";
import { clearBlockRange, setBlockRange } from "./state-actions";

type BlockSelectorDom = {
    inButton: HTMLButtonElement;
    outButton: HTMLButtonElement;
    clearButton: HTMLButtonElement;
    invertButton: HTMLButtonElement;
    invertResetButton: HTMLButtonElement;
    presetFullButton: HTMLButtonElement;
    presetLast2YButton: HTMLButtonElement;
    presetVisibleButton: HTMLButtonElement;
    badge: HTMLElement;
    badgeText: HTMLElement;
    invertLabelText: Text | null;
};

function fmtDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

export class BlockSelectorManager {
    private dom: BlockSelectorDom | null = null;
    private hoveredTime: number | null = null;
    private pendingFrom: number | null = null;
    private preInvertRange: { from: number; to: number } | null = null;
    private blockMarkersPlugin: ISeriesMarkersPluginApi<Time> | null = null;

    private getDom(): BlockSelectorDom {
        if (this.dom) {
            return this.dom;
        }

        const invertButton = getRequiredElement<HTMLButtonElement>('blockSelectorInvert');
        this.dom = {
            inButton: getRequiredElement<HTMLButtonElement>('blockSelectorIn'),
            outButton: getRequiredElement<HTMLButtonElement>('blockSelectorOut'),
            clearButton: getRequiredElement<HTMLButtonElement>('blockSelectorClear'),
            invertButton,
            invertResetButton: getRequiredElement<HTMLButtonElement>('blockSelectorInvertReset'),
            presetFullButton: getRequiredElement<HTMLButtonElement>('blockPresetFull'),
            presetLast2YButton: getRequiredElement<HTMLButtonElement>('blockPresetLast2Y'),
            presetVisibleButton: getRequiredElement<HTMLButtonElement>('blockPresetVisible'),
            badge: getRequiredElement<HTMLElement>('blockSelectorBadge'),
            badgeText: getRequiredElement<HTMLElement>('blockSelectorBadgeText'),
            invertLabelText: Array.from(invertButton.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE) ?? null,
        };

        return this.dom;
    }

    public init(): void {
        const dom = this.getDom();
        dom.inButton.addEventListener('click', () => this.setIn());
        dom.outButton.addEventListener('click', () => this.setOut());
        dom.clearButton.addEventListener('click', () => this.clear());
        dom.invertButton.addEventListener('click', () => this.invertSelect());
        dom.invertResetButton.addEventListener('click', () => this.restorePreInvert());
        dom.presetFullButton.addEventListener('click', () => this.presetFull());
        dom.presetLast2YButton.addEventListener('click', () => this.presetLast2Y());
        dom.presetVisibleButton.addEventListener('click', () => this.presetVisible());

        state.chart.subscribeCrosshairMove((param) => {
            if (param.time !== undefined && typeof param.time === 'number') {
                this.hoveredTime = param.time;
            }
        });

        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (this.isTypingTarget(e)) return;
            if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                this.setIn();
            } else if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                this.setOut();
            } else if (e.key === 'Escape' && state.blockRange !== null) {
                e.preventDefault();
                this.clear();
            }
        });

        state.subscribe('blockRange', () => this.updateUI());
        this.updateUI();
    }

    private isTypingTarget(e: KeyboardEvent): boolean {
        const tag = (e.target as HTMLElement | null)?.tagName ?? '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return true;
        if ((e.target as HTMLElement | null)?.isContentEditable) return true;
        return false;
    }

    private setIn(): void {
        this.preInvertRange = null;
        const ts = this.hoveredTime ?? this.getChartVisibleFrom() ?? this.getDataFrom();
        if (ts === null) return;

        this.pendingFrom = ts;

        const current = state.blockRange;
        if (current) {
            const newTo = current.to > ts ? current.to : this.getDataTo() ?? ts;
            setBlockRange({ from: ts, to: newTo });
        } else {
            setBlockRange({ from: ts, to: ts });
        }

        this.getDom().inButton.classList.add('is-set');
    }

    private setOut(): void {
        this.preInvertRange = null;
        const ts = this.hoveredTime ?? this.getChartVisibleTo() ?? this.getDataTo();
        if (ts === null) return;

        const from = this.pendingFrom ?? state.blockRange?.from ?? this.getDataFrom() ?? ts;
        const safeFrom = Math.min(from, ts);
        const safeTo = Math.max(from, ts);

        setBlockRange({ from: safeFrom, to: safeTo });
        this.pendingFrom = null;

        this.getDom().outButton.classList.add('is-set');
    }

    public clear(): void {
        const dom = this.getDom();
        this.pendingFrom = null;
        this.preInvertRange = null;
        clearBlockRange();
        dom.inButton.classList.remove('is-set');
        dom.outButton.classList.remove('is-set');
    }

    private invertSelect(): void {
        if (this.preInvertRange) {
            this.restorePreInvert();
            return;
        }

        const current = state.blockRange;
        const dataTo = this.getDataTo();
        if (!current || dataTo === null) return;

        const newFrom = current.to;
        const newTo = dataTo;
        if (newFrom >= newTo) return;

        this.preInvertRange = { from: current.from, to: current.to };
        this.pendingFrom = null;
        setBlockRange({ from: newFrom, to: newTo });
    }

    private restorePreInvert(): void {
        if (!this.preInvertRange) return;
        const restore = this.preInvertRange;
        this.preInvertRange = null;
        this.pendingFrom = null;
        setBlockRange(restore);
    }

    private presetFull(): void {
        this.clear();
    }

    private presetLast2Y(): void {
        const to = this.getDataTo();
        if (to === null) return;
        const twoYearsSeconds = 2 * 365 * 24 * 3600;
        const from = to - twoYearsSeconds;
        const dataFrom = this.getDataFrom() ?? from;
        setBlockRange({ from: Math.max(from, dataFrom), to });
    }

    private presetVisible(): void {
        const from = this.getChartVisibleFrom();
        const to = this.getChartVisibleTo();
        if (from === null || to === null || from >= to) return;
        setBlockRange({ from, to });
    }

    private drawBlockMarkers(block: { from: number; to: number } | null): void {
        if (this.blockMarkersPlugin) {
            this.blockMarkersPlugin.detach();
            this.blockMarkersPlugin = null;
        }

        if (!block || !state.candlestickSeries) return;
        if (block.from === block.to) {
            const markers: SeriesMarker<Time>[] = [
                {
                    time: block.from as Time,
                    position: 'aboveBar',
                    color: 'hsl(30, 95%, 55%)',
                    shape: 'arrowDown',
                    text: 'IN',
                    size: 2,
                },
            ];
            this.blockMarkersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
            return;
        }

        const markers: SeriesMarker<Time>[] = [
            {
                time: block.from as Time,
                position: 'aboveBar',
                color: 'hsl(30, 95%, 55%)',
                shape: 'arrowDown',
                text: 'IN',
                size: 2,
            },
            {
                time: block.to as Time,
                position: 'aboveBar',
                color: 'hsl(30, 95%, 55%)',
                shape: 'arrowDown',
                text: 'OUT',
                size: 2,
            },
        ];

        this.blockMarkersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
    }

    private getChartVisibleFrom(): number | null {
        try {
            const range = state.chart?.timeScale().getVisibleRange();
            if (!range) return null;
            return typeof range.from === 'number' ? range.from : null;
        } catch {
            return null;
        }
    }

    private getChartVisibleTo(): number | null {
        try {
            const range = state.chart?.timeScale().getVisibleRange();
            if (!range) return null;
            return typeof range.to === 'number' ? range.to : null;
        } catch {
            return null;
        }
    }

    private getDataFrom(): number | null {
        const first = state.ohlcvData[0];
        return first ? (first.time as number) : null;
    }

    private getDataTo(): number | null {
        const last = state.ohlcvData[state.ohlcvData.length - 1];
        return last ? (last.time as number) : null;
    }

    private updateUI(): void {
        const dom = this.getDom();
        const block = state.blockRange;
        const hasBlock = block !== null;
        const hasRange = hasBlock && block.from !== block.to;
        const isInverted = this.preInvertRange !== null;

        setVisible(dom.badge, hasBlock);
        setVisible(dom.clearButton, hasBlock);

        dom.invertButton.disabled = !hasRange;
        dom.invertButton.title = isInverted
            ? 'Click again to restore original range'
            : 'Invert: OUT becomes new IN, last candle becomes new OUT';
        if (dom.invertLabelText) {
            dom.invertLabelText.textContent = isInverted ? ' Restore' : ' Invert';
        }
        setVisible(dom.invertResetButton, isInverted);

        if (hasBlock && block) {
            dom.badgeText.textContent = hasRange
                ? `${fmtDate(block.from)} -> ${fmtDate(block.to)}`
                : `${fmtDate(block.from)} -> set OUT`;
        }

        setVisible('finderBlockBadge', hasRange);
        this.drawBlockMarkers(block);
    }
}

export const blockSelectorManager = new BlockSelectorManager();
