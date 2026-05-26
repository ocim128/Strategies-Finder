export interface LatestLoadTicket {
    readonly signal: AbortSignal;
    isActive(): boolean;
    finish(): void;
}

export class LatestLoadGuard {
    private activeId = 0;
    private activeAbort: AbortController | null = null;

    public start(): LatestLoadTicket {
        this.activeAbort?.abort();
        const id = ++this.activeId;
        const abort = new AbortController();
        let finished = false;
        this.activeAbort = abort;

        return {
            signal: abort.signal,
            isActive: () => !finished && this.activeId === id && !abort.signal.aborted,
            finish: () => {
                finished = true;
                if (this.activeId === id) {
                    this.activeAbort = null;
                }
            },
        };
    }
}
