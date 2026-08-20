export interface AnimationFrameCoalescer {
    schedule: () => void;
    cancel: () => void;
}

type FrameHandle = number | ReturnType<typeof setTimeout>;

export function coalesceAnimationFrame(fn: () => void): AnimationFrameCoalescer {
    let frameId: FrameHandle | null = null;

    const flush = (): void => {
        frameId = null;
        fn();
    };

    return {
        schedule: () => {
            if (frameId !== null) return;
            if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                frameId = window.requestAnimationFrame(flush);
            } else {
                frameId = setTimeout(flush, 0);
            }
        },
        cancel: () => {
            if (frameId === null) return;
            if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function" && typeof frameId === "number") {
                window.cancelAnimationFrame(frameId);
            } else {
                clearTimeout(frameId);
            }
            frameId = null;
        },
    };
}

type IdleHandle = number | ReturnType<typeof setTimeout>;

export function scheduleIdleBatched(callback: () => void): IdleHandle {
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        return window.requestIdleCallback(callback);
    }
    return setTimeout(callback, 16);
}

export function cancelIdleBatched(handle: IdleHandle): void {
    if (typeof window !== "undefined" && typeof window.cancelIdleCallback === "function" && typeof handle === "number") {
        window.cancelIdleCallback(handle);
        return;
    }
    clearTimeout(handle);
}
