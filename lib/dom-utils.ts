/** Get a required element, failing at the feature's initialization boundary. */
export function getRequiredElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Required element with id "${id}" not found`);
    return element as T;
}

export function getOptionalElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

export type RequiredDomElementMap<TIds extends Record<string, string>> = {
    [K in keyof TIds]: HTMLElement;
};

export function getRequiredDomIds<TIds extends Record<string, string>>(
    ids: TIds
): readonly TIds[keyof TIds][] {
    return Object.values(ids) as TIds[keyof TIds][];
}

export function getRequiredDomElements<TIds extends Record<string, string>>(
    ids: TIds
): RequiredDomElementMap<TIds> {
    const elements = {} as RequiredDomElementMap<TIds>;
    for (const key of Object.keys(ids) as Array<keyof TIds>) {
        elements[key] = getRequiredElement(ids[key]);
    }
    return elements;
}

/**
 * Build an <option> fragment (value=key, label=name, title=description) for
 * the strategy dropdowns; callers pass the result to replaceChildren().
 */
export function buildStrategyOptions(
    strategies: ReadonlyArray<{ key: string; name: string; description: string }>
): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (const { key, name, description } of strategies) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = name;
        option.title = description;
        fragment.appendChild(option);
    }
    return fragment;
}

/**
 * Set text content of an element and optionally apply a class.
 */
export function updateTextContent(id: string, text: string, className?: string) {
    const element = getOptionalElement(id);
    if (element) {
        element.textContent = text;
        if (className !== undefined) {
            element.className = className;
        }
    }
}

/**
 * Toggle display of an element.
 */
export function setVisible(target: string, visible: boolean, displayMode?: string): void;
export function setVisible(target: HTMLElement | null | undefined, visible: boolean, displayMode?: string): void;
export function setVisible(target: string | HTMLElement | null | undefined, visible: boolean, displayMode: string = 'block') {
    const el = typeof target === 'string' ? getOptionalElement(target) : target;
    if (el) {
        el.style.display = visible ? displayMode : 'none';
    }
}

/**
 * Web storage accessors for runtimes without the API (workers, private
 * browsing, embedded contexts); callers still wrap reads/writes in try/catch.
 */
export function getLocalStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

export function getSessionStorage(): Storage | null {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}


