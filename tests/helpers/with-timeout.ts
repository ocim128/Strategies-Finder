/** Bound an operation without leaving the losing deadline alive after it settles. */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([operation, deadline]);
    } finally {
        clearTimeout(timer);
    }
}
