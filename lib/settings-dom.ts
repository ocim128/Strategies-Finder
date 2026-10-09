export function triggerSettingsChangeEvents(toggleIds: readonly string[]): void {
    for (const id of toggleIds) {
        const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        element?.dispatchEvent(new Event("change", { bubbles: true }));
    }
}
