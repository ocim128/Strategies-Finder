/**
 * Utility functions for DOM manipulation and interaction.
 */

/**
 * Safely get an element by ID and throw an error if not found.
 * Helps with common '!' usage and provides better error messages.
 */
export function getRequiredElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Required element with id "${id}" not found`);
    }
    return element as T;
}

/**
 * Set text content of an element and optionally apply a class.
 */
export function updateTextContent(id: string, text: string, className?: string) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = text;
        if (className !== undefined) {
            el.className = className;
        }
    }
}

/**
 * Toggle display of an element.
 */
export function setVisible(id: string, visible: boolean, displayMode: string = 'block') {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = visible ? displayMode : 'none';
    }
}
