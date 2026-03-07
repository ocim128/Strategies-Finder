const FORM_CONTROL_SELECTOR = 'input:not([type="hidden"]), select, textarea';

let generatedIdCounter = 0;

function ensureElementId(element: HTMLElement, prefix: string): string {
    if (!element.id) {
        generatedIdCounter += 1;
        element.id = `${prefix}-${generatedIdCounter}`;
    }
    return element.id;
}

function bindLabelToControl(label: HTMLElement, control: HTMLElement): void {
    const controlId = ensureElementId(control, 'a11y-control');
    const labelId = ensureElementId(label, `${controlId}-label`);

    if (label instanceof HTMLLabelElement) {
        label.htmlFor = controlId;
    }

    control.setAttribute('aria-labelledby', labelId);
}

function bindGroupedLabels(root: ParentNode): void {
    const groups = root.querySelectorAll<HTMLElement>('.param-group');
    groups.forEach((group) => {
        const label = group.querySelector<HTMLElement>('.param-label');
        const control = group.querySelector<HTMLElement>(FORM_CONTROL_SELECTOR);
        if (!label || !control) return;
        bindLabelToControl(label, control);
    });
}

function bindStandaloneControlLabels(root: ParentNode): void {
    const standaloneLabels: Array<{ id: string; label: string }> = [
        { id: 'configNameInput', label: 'Configuration name' },
        { id: 'configSelect', label: 'Saved configuration' },
        { id: 'strategySelect', label: 'Strategy' },
        { id: 'shareConfigLinkInput', label: 'Generated share link' },
        { id: 'shareConfigImportInput', label: 'Shared strategy link or token' },
    ];

    standaloneLabels.forEach(({ id, label }) => {
        const control = root.querySelector<HTMLElement>(`#${id}`);
        if (!control) return;
        if (!control.getAttribute('aria-label')) {
            control.setAttribute('aria-label', label);
        }
    });
}

export function bindFormAccessibility(root: ParentNode = document): void {
    bindGroupedLabels(root);
    bindStandaloneControlLabels(root);
}
