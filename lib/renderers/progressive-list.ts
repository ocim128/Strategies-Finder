import { cancelIdleBatched, scheduleIdleBatched } from "../render-scheduler";

export interface ProgressiveListRenderOptions<T> {
    container: HTMLElement;
    /** Full list; the renderer paints at most maxItems of it. */
    items: readonly T[];
    maxItems: number;
    initialBatchSize: number;
    deferredBatchSize: number;
    /** Builds the HTML for items[startIndex, endIndex). */
    renderChunk: (items: readonly T[], startIndex: number, endIndex: number) => string;
    /**
     * Builds the "showing N of M" notice appended after the last chunk.
     * Return '' (or omit) when the list is not truncated.
     */
    renderLimitNotice?: (fullListLength: number) => string;
}

/**
 * Shared progressive-list renderer: paints an initial chunk synchronously,
 * then appends the rest in idle callbacks. A generation counter aborts
 * in-flight appends the moment a newer render (or invalidate) starts, so
 * chunks from a previous list can never land in a fresh container.
 */
export class ProgressiveListRenderer<T> {
    private generation = 0;
    private pendingHandles: Array<ReturnType<typeof scheduleIdleBatched>> = [];

    public render(options: ProgressiveListRenderOptions<T>): void {
        this.cancelPendingAppends();
        const renderGeneration = ++this.generation;
        const { container, renderChunk } = options;
        const toRender = options.items.slice(0, options.maxItems);
        const initialCount = Math.min(toRender.length, options.initialBatchSize);
        container.innerHTML = renderChunk(toRender, 0, initialCount);

        let offset = initialCount;
        const appendLimitNotice = () => {
            if (renderGeneration !== this.generation) {
                return;
            }
            const noticeHtml = options.renderLimitNotice?.(options.items.length) ?? '';
            if (!noticeHtml) {
                return;
            }
            container.appendChild(document.createRange().createContextualFragment(noticeHtml));
        };

        if (offset >= toRender.length) {
            appendLimitNotice();
            return;
        }

        const appendChunk = () => {
            if (renderGeneration !== this.generation) {
                return;
            }

            const nextOffset = Math.min(offset + options.deferredBatchSize, toRender.length);
            container.appendChild(document.createRange().createContextualFragment(
                renderChunk(toRender, offset, nextOffset)
            ));
            offset = nextOffset;

            if (offset < toRender.length) {
                this.scheduleAppend(appendChunk);
                return;
            }

            appendLimitNotice();
        };

        this.scheduleAppend(appendChunk);
    }

    /** Cancels pending appends and invalidates any chunk already in flight. */
    public invalidate(): void {
        this.cancelPendingAppends();
        this.generation += 1;
    }

    private cancelPendingAppends(): void {
        for (const handle of this.pendingHandles) {
            cancelIdleBatched(handle);
        }
        this.pendingHandles = [];
    }

    private scheduleAppend(callback: () => void): void {
        this.pendingHandles.push(scheduleIdleBatched(callback));
    }
}
