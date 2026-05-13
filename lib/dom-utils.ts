const elementCache: Map<string, HTMLElement> = new Map();

/**
 * Safely get an element by ID and throw an error if not found.
 * Caches the element for future lookups.
 */
export function getRequiredElement<T extends HTMLElement>(id: string): T {
    let element = elementCache.get(id);
    if (!element) {
        element = document.getElementById(id) || undefined;
        if (element) {
            elementCache.set(id, element);
        }
    }

    if (!element) {
        throw new Error(`Required element with id "${id}" not found`);
    }
    return element as T;
}

export function getOptionalElement<T extends HTMLElement>(id: string): T | null {
    return (document.getElementById(id) as T | null) ?? null;
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
 * Set text content of an element and optionally apply a class.
 */
export function updateTextContent(id: string, text: string, className?: string) {
    const cachedEl = getElementByIdCached(id);
    if (cachedEl) {
        cachedEl.textContent = text;
        if (className !== undefined) {
            cachedEl.className = className;
        }
    }
}

/**
 * Internal helper for cached lookup
 */
function getElementByIdCached(id: string): HTMLElement | null {
    let element = elementCache.get(id);
    if (!element) {
        element = document.getElementById(id) || undefined;
        if (element) {
            elementCache.set(id, element);
        }
    }
    return element || null;
}

/**
 * Toggle display of an element.
 */
export function setVisible(target: string, visible: boolean, displayMode?: string): void;
export function setVisible(target: HTMLElement | null | undefined, visible: boolean, displayMode?: string): void;
export function setVisible(target: string | HTMLElement | null | undefined, visible: boolean, displayMode: string = 'block') {
    const el = typeof target === 'string' ? getElementByIdCached(target) : target;
    if (el) {
        el.style.display = visible ? displayMode : 'none';
    }
}

