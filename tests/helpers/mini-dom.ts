/**
 * Minimal DOM stand-in for Finder results-table tests. Supports exactly what
 * `FinderUI` rendering and `appendFinderResultsTable` need from `document`:
 * element creation/appending/removal, `textContent`, class/attribute/dataset
 * access, event listeners, and the small selector subset the table code uses
 * (class compounds, tag names, descendant and child combinators, attribute
 * presence). Real traversal — no stubbed `querySelectorAll`.
 */

type MiniListener = (event?: { type: string; target?: unknown }) => void;

const camelToData = (property: string): string =>
    `data-${property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;

function matchesCompound(node: MiniElement, compound: string): boolean {
    const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(compound);
    if (tagMatch && node.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    for (const match of compound.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
        if (!node.classList.contains(match[1]!)) return false;
    }
    for (const match of compound.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)) {
        const value = node.getAttribute(match[1]!);
        if (value === null) return false;
        if (match[2] !== undefined && value !== match[2]) return false;
    }
    return true;
}

function matchesFrom(node: MiniElement, tokens: string[], index: number): boolean {
    if (!matchesCompound(node, tokens[index]!)) return false;
    if (index === 0) return true;
    if (tokens[index - 1] === ">") {
        const parent = node.parentNode;
        return parent !== null && matchesFrom(parent, tokens, index - 2);
    }
    let ancestor = node.parentNode;
    while (ancestor !== null) {
        if (matchesFrom(ancestor, tokens, index - 1)) return true;
        ancestor = ancestor.parentNode;
    }
    return false;
}

export class MiniElement {
    public tagName: string;
    public children: MiniElement[] = [];
    public parentNode: MiniElement | null = null;
    public className = "";
    public textContent = "";
    public style = { display: "" };
    public tabIndex = 0;
    public disabled = false;
    public title = "";
    public checked = false;
    public value = "";
    public hidden = false;
    public open = false;
    public scope: string | null = null;
    public isFragment = false;
    public attributes = new Map<string, string>();
    public listeners = new Map<string, Set<MiniListener>>();
    private innerHtmlValue = "";

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    /** Mirrors real DOM semantics for the one pattern render code relies on: clearing. */
    get innerHTML(): string {
        return this.innerHtmlValue;
    }

    set innerHTML(value: string) {
        this.innerHtmlValue = value;
        if (value === "") {
            for (const child of [...this.children]) this.removeChild(child);
        }
    }

    get isConnected(): boolean {
        let node: MiniElement | null = this;
        while (node.parentNode !== null) node = node.parentNode;
        return node.isFragment === false && node.tagName === "#root";
    }

    get classList() {
        const names = () => this.className.split(/\s+/).filter(Boolean);
        const element = this;
        return {
            add(...added: string[]) {
                const set = new Set(names());
                for (const name of added) set.add(name);
                element.className = [...set].join(" ");
            },
            remove(...removed: string[]) {
                const set = new Set(names());
                for (const name of removed) set.delete(name);
                element.className = [...set].join(" ");
            },
            toggle(name: string, force = !names().includes(name)) {
                const set = new Set(names());
                if (force) set.add(name);
                else set.delete(name);
                element.className = [...set].join(" ");
                return force;
            },
            contains(name: string) {
                return names().includes(name);
            },
        };
    }

    get dataset(): Record<string, string | undefined> {
        const element = this;
        return new Proxy({}, {
            get(_target, property: string) {
                return element.getAttribute(camelToData(property));
            },
            set(_target, property: string, value: string) {
                element.setAttribute(camelToData(property), value);
                return true;
            },
        }) as Record<string, string | undefined>;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, String(value));
    }

    getAttribute(name: string): string | null {
        return this.attributes.has(name) ? this.attributes.get(name)! : null;
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    appendChild<T extends MiniElement>(child: T): T {
        if (child.isFragment) {
            for (const grandchild of [...child.children]) {
                this.appendChild(grandchild);
            }
            return child;
        }
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child: MiniElement): MiniElement {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }

    remove(): void {
        this.parentNode?.removeChild(this);
    }

    addEventListener(type: string, handler: MiniListener): void {
        const handlers = this.listeners.get(type) ?? new Set<MiniListener>();
        handlers.add(handler);
        this.listeners.set(type, handlers);
    }

    removeEventListener(type: string, handler: MiniListener): void {
        this.listeners.get(type)?.delete(handler);
    }

    dispatchEvent(event: { type: string; target?: unknown }): boolean {
        const handlers = this.listeners.get(event.type);
        if (!handlers?.size) return false;
        for (const handler of [...handlers]) handler({ ...event, target: event.target ?? this });
        return true;
    }

    querySelectorAll(selector: string): MiniElement[] {
        const tokens = selector.trim().split(/\s+/);
        const found: MiniElement[] = [];
        const walk = (node: MiniElement): void => {
            for (const child of node.children) {
                if (matchesFrom(child, tokens, tokens.length - 1)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector: string): MiniElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    closest(selector: string): MiniElement | null {
        const tokens = selector.trim().split(/\s+/);
        let node: MiniElement | null = this;
        while (node !== null) {
            if (matchesFrom(node, tokens, tokens.length - 1)) return node;
            node = node.parentNode;
        }
        return null;
    }
}

export interface MiniDom {
    root: MiniElement;
    body: MiniElement;
    documentElement: MiniElement;
    elementsById: Map<string, MiniElement>;
    createElement(tag: string): MiniElement;
    createDocumentFragment(): MiniElement;
    getElementById(id: string): MiniElement | null;
    addEventListener(): void;
    /** Register an existing node under an id so `getElementById` finds it. */
    registerId(id: string, element: MiniElement): void;
}

/** Ids FinderUI resolves through the shared element cache. */
export const MINI_DOM_FINDER_UI_IDS = [
    "finderList",
    "finderCopyTopResults",
    "finderEmpty",
    "finderProgress",
    "finderProgressFill",
    "finderProgressText",
    "finderStatus",
    "finderBenchmark",
    "finderBenchmarkBody",
] as const;

export function createMiniDom(precreatedIds: readonly string[] = MINI_DOM_FINDER_UI_IDS): MiniDom {
    const root = new MiniElement("#root");
    const body = new MiniElement("body");
    root.appendChild(body);
    const elementsById = new Map<string, MiniElement>();
    for (const id of precreatedIds) {
        const element = new MiniElement("div");
        element.attributes.set("id", id);
        body.appendChild(element);
        elementsById.set(id, element);
    }
    const documentShim: MiniDom = {
        root,
        body,
        documentElement: root,
        elementsById,
        createElement: (tag: string) => new MiniElement(tag),
        createDocumentFragment: () => {
            const fragment = new MiniElement("#fragment");
            fragment.isFragment = true;
            return fragment;
        },
        getElementById: (id: string) => elementsById.get(id) ?? null,
        addEventListener: () => {},
        registerId: (id: string, element: MiniElement) => {
            body.appendChild(element);
            elementsById.set(id, element);
        },
    };
    return documentShim;
}
