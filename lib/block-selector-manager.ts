import { createSeriesMarkers, ISeriesMarkersPluginApi, SeriesMarker, Time } from "lightweight-charts";
import { state } from "./state";
import { getRequiredElement } from "./dom-utils";
import { setVisible } from "./dom-utils";

function fmtDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

export class BlockSelectorManager {
    /** Timestamp of currently hovered candle (updated via crosshair subscription) */
    private hoveredTime: number | null = null;

    /** The pending IN timestamp (set before OUT is confirmed) */
    private pendingFrom: number | null = null;

    /** Saved range from before the last Invert, enabling toggle-back on second click. */
    private preInvertRange: { from: number; to: number } | null = null;

    /** Dedicated markers plugin instance for block IN/OUT markers (separate from trade markers) */
    private blockMarkersPlugin: ISeriesMarkersPluginApi<Time> | null = null;

    public init(): void {
        getRequiredElement('blockSelectorIn').addEventListener('click', () => this.setIn());
        getRequiredElement('blockSelectorOut').addEventListener('click', () => this.setOut());
        getRequiredElement('blockSelectorClear').addEventListener('click', () => this.clear());
        getRequiredElement('blockSelectorInvert').addEventListener('click', () => this.invertSelect());
        getRequiredElement('blockSelectorInvertReset').addEventListener('click', () => this.restorePreInvert());
        getRequiredElement('blockPresetFull').addEventListener('click', () => this.presetFull());
        getRequiredElement('blockPresetLast2Y').addEventListener('click', () => this.presetLast2Y());
        getRequiredElement('blockPresetVisible').addEventListener('click', () => this.presetVisible());

        // Track crosshair to know which candle the user is hovering over
        state.chart.subscribeCrosshairMove((param) => {
            if (param.time !== undefined && typeof param.time === 'number') {
                this.hoveredTime = param.time;
            }
        });

        // Keyboard shortcuts — I = IN, O = OUT, Escape = clear
        // Guard: skip when a text input / textarea / select is focused
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (this.isTypingTarget(e)) return;
            if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                this.setIn();
            } else if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                this.setOut();
            } else if (e.key === 'Escape' && state.blockRange !== null) {
                // Only consume Escape when a block is active, so it doesn't break other Escape handlers
                e.preventDefault();
                this.clear();
            }
        });

        // React to block state changes — update badge + chart markers
        state.subscribe('blockRange', () => this.updateUI());
        this.updateUI();
    }

    /** Returns true when the event target is a text-entry element (prevents shortcut misfires). */
    private isTypingTarget(e: KeyboardEvent): boolean {
        const tag = (e.target as HTMLElement | null)?.tagName ?? '';
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return true;
        if ((e.target as HTMLElement | null)?.isContentEditable) return true;
        return false;
    }

    // ─── IN / OUT Pin Logic ────────────────────────────────────────────────────

    private setIn(): void {
        this.preInvertRange = null; // manual change breaks invert toggle
        const ts = this.hoveredTime ?? this.getChartVisibleFrom() ?? this.getDataFrom();
        if (ts === null) return;

        this.pendingFrom = ts;

        // If there's already a committed block, update its FROM
        const current = state.blockRange;
        if (current) {
            const newTo = current.to > ts ? current.to : this.getDataTo() ?? ts;
            state.set('blockRange', { from: ts, to: newTo });
        } else {
            // Show partial state: set block with same from/to until OUT is clicked
            state.set('blockRange', { from: ts, to: ts });
        }

        document.getElementById('blockSelectorIn')?.classList.add('is-set');
    }

    private setOut(): void {
        this.preInvertRange = null; // manual change breaks invert toggle
        const ts = this.hoveredTime ?? this.getChartVisibleTo() ?? this.getDataTo();
        if (ts === null) return;

        const from = this.pendingFrom ?? state.blockRange?.from ?? this.getDataFrom() ?? ts;
        // Ensure from < to
        const safeFrom = Math.min(from, ts);
        const safeTo = Math.max(from, ts);

        state.set('blockRange', { from: safeFrom, to: safeTo });
        this.pendingFrom = null;

        document.getElementById('blockSelectorOut')?.classList.add('is-set');
    }

    public clear(): void {
        this.pendingFrom = null;
        this.preInvertRange = null;
        state.set('blockRange', null);
        document.getElementById('blockSelectorIn')?.classList.remove('is-set');
        document.getElementById('blockSelectorOut')?.classList.remove('is-set');
    }

    /** Toggle invert: 1st click saves original and applies invert; 2nd click restores original. */
    private invertSelect(): void {
        // If already inverted, toggle back
        if (this.preInvertRange) {
            this.restorePreInvert();
            return;
        }

        const current = state.blockRange;
        const dataTo = this.getDataTo();
        if (!current || dataTo === null) return;

        const newFrom = current.to;
        const newTo = dataTo;
        if (newFrom >= newTo) return; // Already at the end

        // Save original so we can toggle back
        this.preInvertRange = { from: current.from, to: current.to };
        this.pendingFrom = null;
        state.set('blockRange', { from: newFrom, to: newTo });
    }

    /** Restore the range that existed before inverting. */
    private restorePreInvert(): void {
        if (!this.preInvertRange) return;
        const restore = this.preInvertRange;
        this.preInvertRange = null;
        this.pendingFrom = null;
        state.set('blockRange', restore);
    }

    // ─── Presets ────────────────────────────────────────────────────────────────

    private presetFull(): void {
        this.clear();
    }

    private presetLast2Y(): void {
        const to = this.getDataTo();
        if (to === null) return;
        const twoYearsSeconds = 2 * 365 * 24 * 3600;
        const from = to - twoYearsSeconds;
        const dataFrom = this.getDataFrom() ?? from;
        state.set('blockRange', { from: Math.max(from, dataFrom), to });
    }

    private presetVisible(): void {
        const from = this.getChartVisibleFrom();
        const to = this.getChartVisibleTo();
        if (from === null || to === null || from >= to) return;
        state.set('blockRange', { from, to });
    }

    // ─── Chart Markers ─────────────────────────────────────────────────────────

    private drawBlockMarkers(block: { from: number; to: number } | null): void {
        // Detach old block markers plugin
        if (this.blockMarkersPlugin) {
            this.blockMarkersPlugin.detach();
            this.blockMarkersPlugin = null;
        }

        if (!block || !state.candlestickSeries) return;
        if (block.from === block.to) {
            // Only IN set so far — show a single IN marker
            const markers: SeriesMarker<Time>[] = [
                {
                    time: block.from as Time,
                    position: 'aboveBar',
                    color: 'hsl(30, 95%, 55%)',
                    shape: 'arrowDown',
                    text: '◀ IN',
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
                text: '▶ IN',
                size: 2,
            },
            {
                time: block.to as Time,
                position: 'aboveBar',
                color: 'hsl(30, 95%, 55%)',
                shape: 'arrowDown',
                text: 'OUT ◀',
                size: 2,
            },
        ];

        this.blockMarkersPlugin = createSeriesMarkers(state.candlestickSeries, markers);
    }

    // ─── Chart / Data Helpers ──────────────────────────────────────────────────

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

    // ─── UI Update ─────────────────────────────────────────────────────────────

    private updateUI(): void {
        const block = state.blockRange;
        const hasBlock = block !== null;
        const hasRange = hasBlock && block.from !== block.to;

        // Header badge — show as soon as IN is set (even partial block)
        setVisible('blockSelectorBadge', hasBlock);
        setVisible('blockSelectorClear', hasBlock);

        // Invert is always visible but disabled until a full range is set
        const invertBtn = document.getElementById('blockSelectorInvert') as HTMLButtonElement | null;
        if (invertBtn) {
            invertBtn.disabled = !hasRange;
            // Change label to signal the toggle-back when in inverted state
            const isInverted = this.preInvertRange !== null;
            invertBtn.title = isInverted
                ? 'Click again to restore original range'
                : 'Invert: OUT becomes new IN, last candle becomes new OUT';
            // Update the text node inside the button (svg + text)
            const textNode = Array.from(invertBtn.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
            if (textNode) textNode.textContent = isInverted ? ' Restore' : ' Invert';
        }
        // Show the ✕ reset-invert button only while in inverted state
        setVisible('blockSelectorInvertReset', this.preInvertRange !== null);

        if (hasBlock && block) {
            const badgeText = document.getElementById('blockSelectorBadgeText');
            if (badgeText) {
                if (hasRange) {
                    badgeText.textContent = `${fmtDate(block.from)} → ${fmtDate(block.to)}`;
                } else {
                    badgeText.textContent = `${fmtDate(block.from)} → set OUT`;
                }
            }
        }

        // Finder tab badge — only when a full range is selected
        setVisible('finderBlockBadge', hasRange);

        // Chart markers
        this.drawBlockMarkers(block);
    }
}

export const blockSelectorManager = new BlockSelectorManager();
