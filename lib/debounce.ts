export type DebouncedFunction<T extends (...args: any[]) => void> = T & {
    cancel: () => void;
};

export function debounce<T extends (...args: any[]) => void>(
    fn: T,
    delay: number
): DebouncedFunction<(...args: Parameters<T>) => void> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debounced = ((...args: Parameters<T>) => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            timeoutId = null;
            fn(...args);
        }, delay);
    }) as DebouncedFunction<(...args: Parameters<T>) => void>;
    debounced.cancel = () => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };
    return debounced;
}
