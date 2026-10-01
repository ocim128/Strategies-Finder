import { createFakeElement } from "./fake-element";
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
    return Object.assign(createFakeElement(), {
        className: "",
        dataset: {},
        isConnected: true,
        options: [] as unknown[],
        querySelector: () => null,
        closest: () => null,
        getAttribute: () => null,
    });
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
