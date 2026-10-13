export type DebouncedFunction<T extends (...args: any[]) => void> = T & {
    cancel: () => void;
    flush: () => void;
};

export function debounce<T extends (...args: any[]) => void>(
    fn: T,
    delay: number
): DebouncedFunction<(...args: Parameters<T>) => void> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingArgs: Parameters<T> | null = null;

    const executePending = () => {
        const argsToUse = pendingArgs;
        pendingArgs = null;
        if (argsToUse !== null) fn(...argsToUse);
    };

    const debounced = ((...args: Parameters<T>) => {
        pendingArgs = args;
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            timeoutId = null;
            executePending();
        }, delay);
    }) as DebouncedFunction<(...args: Parameters<T>) => void>;
    debounced.cancel = () => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingArgs = null;
    };
    debounced.flush = () => {
        if (timeoutId === null) return;
        clearTimeout(timeoutId);
        timeoutId = null;
        executePending();
    };
    return debounced;
}
