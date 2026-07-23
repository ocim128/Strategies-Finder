/**
 * Shared fake Batch DOM factory derived from `BATCH_BACKTEST_REQUIRED_IDS`.
 * Keeps browser lifecycle fixtures aligned with the live DOM contract so
 * removed controls cannot silently reappear and new TOP_MEAN fields cannot
 * drift out of test setup.
 */
import {
    BATCH_BACKTEST_REQUIRED_IDS,
    type BatchBacktestDom,
} from "../../lib/batch-backtest/batch-backtest-dom";

export function createFakeBatchElement(): any {
    const listeners = new Map<string, Array<() => void>>();
    const classes = new Set<string>();
    const el: any = {
        style: { display: "", width: "" },
        disabled: false,
        value: "",
        checked: false,
        textContent: "",
        hidden: false,
        innerHTML: "",
        classList: {
            add(...cls: string[]) { for (const c of cls) classes.add(c); },
            remove(...cls: string[]) { for (const c of cls) classes.delete(c); },
            toggle(cls: string, force?: boolean) {
                if (force === undefined) { if (classes.has(cls)) classes.delete(cls); else classes.add(cls); }
                else if (force) classes.add(cls); else classes.delete(cls);
            },
            contains(cls: string) { return classes.has(cls); },
        },
        replaceChildren: () => { el.children = []; },
        appendChild: (child: any) => { el.children = el.children ?? []; el.children.push(child); return child; },
        addEventListener: (type: string, handler: () => void) => {
            const arr = listeners.get(type) ?? [];
            arr.push(handler);
            listeners.set(type, arr);
        },
        removeEventListener: () => {},
        dispatchEvent: (ev: { type: string }): boolean => {
            const arr = listeners.get(ev.type);
            if (!arr || arr.length === 0) return false;
            for (const handler of arr) handler();
            return true;
        },
        click(): boolean {
            const arr = listeners.get("click");
            if (!arr || arr.length === 0) return false;
            for (const handler of arr) handler();
            return true;
        },
        children: [] as any[],
        setAttribute: () => {},
    };
    return el;
}

const DEFAULT_VALUES: Partial<Record<(typeof BATCH_BACKTEST_REQUIRED_IDS)[number], string>> = {
    batchBacktestBalancedMaxPairs: "2000",
    batchBacktestBalancedSeed: "1",
    batchBacktestOpenScoreUsdHorizons: "12,24,48",
    batchBacktestSp500TopMeanHorizons: "12,24,48",
    batchBacktestSp500TopMeanWorkers: "4",
    batchBacktestSp500TopMeanMaxPairs: "",
    batchBacktestSp500TopMeanStabilityDates: "",
};

/**
 * Build a complete `BatchBacktestDom` shell with one fake element per required
 * id. Override individual fields after construction when a test needs seeded
 * values (e.g. balanced assets textarea).
 */
export function createFakeBatchBacktestDom(): BatchBacktestDom {
    const dom: Record<string, any> = {};
    for (const id of BATCH_BACKTEST_REQUIRED_IDS) {
        const el = createFakeBatchElement();
        const defaultValue = DEFAULT_VALUES[id];
        if (defaultValue !== undefined) {
            el.value = defaultValue;
        }
        dom[id] = el;
    }
    return dom as BatchBacktestDom;
}
