/**
 * Shared fake Finder DOM factory derived from `FINDER_MANAGER_REQUIRED_IDS`.
 * Keeps browser lifecycle fixtures aligned with the live DOM contract so
 * removed controls cannot silently reappear and new fields cannot drift out
 * of test setup.
 */
import {
    FINDER_MANAGER_REQUIRED_IDS,
    type FinderManagerDom,
} from "../../lib/finder/finder-manager-dom";

export function createFakeFinderElement(): any {
    const listeners = new Map<string, Array<(event?: any) => void>>();
    const classes = new Set<string>();
    const el: any = {
        style: { display: "", width: "" },
        disabled: false,
        value: "",
        checked: false,
        textContent: "",
        hidden: false,
        innerHTML: "",
        className: "",
        dataset: {},
        isConnected: true,
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
        addEventListener: (type: string, handler: (event?: any) => void) => {
            const arr = listeners.get(type) ?? [];
            arr.push(handler);
            listeners.set(type, arr);
        },
        removeEventListener: () => {},
        dispatchEvent: (ev: { type: string; bubbles?: boolean }): boolean => {
            const arr = listeners.get(ev.type);
            if (!arr || arr.length === 0) return false;
            for (const handler of arr) handler(ev);
            return true;
        },
        click(): boolean {
            const arr = listeners.get("click");
            if (!arr || arr.length === 0) return false;
            for (const handler of arr) handler();
            return true;
        },
        children: [] as any[],
        options: [] as any[],
        querySelectorAll: () => [],
        querySelector: () => null,
        closest: () => null,
        setAttribute: () => {},
        getAttribute: () => null,
    };
    return el;
}

/**
 * Build a complete `FinderManagerDom` shell with one fake element per required
 * id. Override individual fields after construction when a test needs seeded
 * values.
 */
export function createFakeFinderManagerDom(): FinderManagerDom {
    const dom: Record<string, any> = {};
    for (const id of FINDER_MANAGER_REQUIRED_IDS) {
        dom[id] = createFakeFinderElement();
    }
    return dom as FinderManagerDom;
}
