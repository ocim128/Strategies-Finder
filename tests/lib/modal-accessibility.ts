const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: ParentNode): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute('aria-hidden'));
}

export type AccessibleModalController = {
    close: () => void;
    open: () => void;
    isOpen: () => boolean;
};

export function createAccessibleModal(options: {
    overlayId: string;
    titleId: string;
    dialogSelector?: string;
    initialFocusSelector?: string;
}): AccessibleModalController {
    const {
        overlayId,
        titleId,
        dialogSelector = '.modal',
        initialFocusSelector = '.modal-close',
    } = options;

    let lastFocusedElement: HTMLElement | null = null;

    const getOverlay = (): HTMLElement | null => document.getElementById(overlayId);
    const getDialog = (): HTMLElement | null => getOverlay()?.querySelector<HTMLElement>(dialogSelector) ?? null;

    const syncAttributes = (): void => {
        const overlay = getOverlay();
        const dialog = getDialog();
        if (!overlay || !dialog) return;

        overlay.setAttribute('aria-hidden', overlay.classList.contains('active') ? 'false' : 'true');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', titleId);
        if (!dialog.hasAttribute('tabindex')) {
            dialog.tabIndex = -1;
        }
    };

    const focusInitialElement = (): void => {
        const dialog = getDialog();
        if (!dialog) return;

        const requested = dialog.querySelector<HTMLElement>(initialFocusSelector);
        const [firstFocusable] = getFocusableElements(dialog);
        const target = requested ?? firstFocusable ?? dialog;
        target.focus({ preventScroll: true });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        const overlay = getOverlay();
        const dialog = getDialog();
        if (!overlay || !dialog || !overlay.classList.contains('active')) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            controller.close();
            return;
        }

        if (event.key !== 'Tab') return;

        const focusable = getFocusableElements(dialog);
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus({ preventScroll: true });
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (event.shiftKey) {
            if (!active || active === first || !dialog.contains(active)) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
            return;
        }

        if (!active || active === last || !dialog.contains(active)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    };

    const controller: AccessibleModalController = {
        open: () => {
            const overlay = getOverlay();
            if (!overlay) return;

            lastFocusedElement = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;

            overlay.classList.add('active');
            syncAttributes();
            document.body.classList.add('focus-trap-active');
            requestAnimationFrame(focusInitialElement);
        },
        close: () => {
            const overlay = getOverlay();
            if (!overlay) return;

            overlay.classList.remove('active');
            syncAttributes();
            document.body.classList.remove('focus-trap-active');

            if (lastFocusedElement && lastFocusedElement.isConnected) {
                lastFocusedElement.focus({ preventScroll: true });
            }
        },
        isOpen: () => getOverlay()?.classList.contains('active') ?? false,
    };

    const overlay = getOverlay();
    if (overlay) {
        overlay.addEventListener('keydown', onKeyDown);
    }

    syncAttributes();
    return controller;
}
