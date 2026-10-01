type FakeEvent = { type: string; [key: string]: unknown };
type Listener = (event?: FakeEvent) => void;

/** The element behavior shared by Finder and Batch lifecycle harnesses. */
export function createFakeElement() {
    const listeners = new Map<string, Set<Listener>>();
    const classes = new Set<string>();
    return {
        style: { display: "", width: "" },
        disabled: false,
        value: "",
        checked: false,
        textContent: "",
        hidden: false,
        innerHTML: "",
        children: [] as unknown[],
        classList: {
            add(...names: string[]) { for (const name of names) classes.add(name); },
            remove(...names: string[]) { for (const name of names) classes.delete(name); },
            toggle(name: string, force = !classes.has(name)) {
                if (force) classes.add(name);
                else classes.delete(name);
                return force;
            },
            contains(name: string) { return classes.has(name); },
        },
        replaceChildren(...children: unknown[]) { this.children = [...children]; },
        appendChild<T>(child: T): T { this.children.push(child); return child; },
        querySelectorAll: () => [],
        setAttribute: () => {},
        addEventListener(type: string, handler: Listener) {
            const handlers = listeners.get(type) ?? new Set<Listener>();
            handlers.add(handler);
            listeners.set(type, handlers);
        },
        removeEventListener(type: string, handler: Listener) {
            listeners.get(type)?.delete(handler);
        },
        // Harness convention: report whether a listener ran, rather than DOM
        // cancellation status, so existing button-wiring assertions remain useful.
        dispatchEvent(event: FakeEvent): boolean {
            const handlers = listeners.get(event.type);
            if (!handlers?.size) return false;
            for (const handler of [...handlers]) {
                if (handlers.has(handler)) handler(event);
            }
            return true;
        },
        click(): boolean {
            return this.dispatchEvent({ type: "click", target: this, currentTarget: this });
        },
    };
}
